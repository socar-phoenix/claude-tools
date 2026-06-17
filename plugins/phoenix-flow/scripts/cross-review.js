#!/usr/bin/env node
// phoenix-flow: AI 교차검토 읽기전용 래퍼
//
// gemini + codex 를 "읽기전용"으로 병렬 실행해 코드 변경(diff) 또는 지정 파일을 교차검토한다.
// 두 결과의 종합은 메인 Claude 가 한다 — 이 스크립트는 도구별 원문을 구분해 그대로 반환만 한다.
//
// 읽기전용 강제(둘 다 yolo/bypass 가 끼어들 여지를 없앤다):
//   - gemini: `--approval-mode plan` (읽기전용 모드). spawn 으로 바이너리를 직접 부르므로
//             쉘 alias(`gemini --approval-mode=yolo`)는 적용되지 않는다.
//   - codex : `exec --sandbox read-only` (model 이 만든 쉘 명령의 쓰기 차단).
//   - 검토 대상은 argv 가 아니라 stdin 으로만 주입한다(ARG_MAX/E2BIG 회피). 도구에는
//     "준 내용만 검토하고 저장소의 다른 파일은 읽거나 수정하지 마라"라고 지시한다.
//
// 정보유출 방어(핵심 — 도구 내장 ignore 에 의존하지 않는다):
//   - 검토 대상은 git 이 아는 것만 넣는다. diff 모드는 `git diff`, 경로 모드는 `git ls-files`(tracked)만.
//     .gitignore 된 .env/키/node_modules 는 애초에 입력에 안 들어간다.
//   - 추가로 symlink·바이너리·대용량 파일을 직접 거른다.
//   - 도구는 저장소 밖 '빈 임시 cwd' 에서 실행 + codex --ignore-rules/--ignore-user-config/--ephemeral,
//     gemini --skip-trust 로 주변 탐색·side-effect 표면을 줄인다.
//     ⚠️ 단 이건 '하드 차단'이 아니다 — 읽기전용 플래그는 쓰기만 막고, 모델이 절대경로로 repo 의 .env 를
//     직접 읽는 것까진 못 막는다. 그 보장은 OS 샌드박스(sandbox-exec read deny) 영역 — 후속 옵션.
//
// 한쪽 도구가 실패/타임아웃해도 다른 쪽 결과는 반환한다(부분 실패 허용).

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 상한/기본값 ──
const PER_TOOL_TIMEOUT_MS_DEFAULT = 180_000;  // 도구별 기본 타임아웃
const MAX_FILE_BYTES = 256 * 1024;            // 경로 모드: 파일 1개 상한
const MAX_PAYLOAD_BYTES = 512 * 1024;         // 검토 대상 전체 상한
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;     // 도구 출력 캡처 상한(maxBuffer 함정 방지)
const TEXT_SNIFF_BYTES = 8 * 1024;            // 바이너리 판별용 앞부분
const GIT_DIFF_MAXBUF = 64 * 1024 * 1024;     // git diff 추출용(ENOBUFS 방지 — 크기는 clamp 가 처리)

// 민감 파일명 차단 — untracked(.gitignore 미존중) 신규 파일이 섞여도 비밀이 새지 않게 한 겹 더.
const SENSITIVE_RE = /(^|\/)(\.env($|\.)|\.netrc$|\.pgpass$|id_rsa|id_ed25519|credentials($|\.)|.*\.(pem|key|p12|pfx|crt|cer|keystore|jks)$)/i;

// 실행 중인 도구 자식 프로세스(시그널 시 process-group 까지 정리하기 위해 추적)
const activeChildren = new Set();

const INSTRUCTION =
  '아래 stdin 내용은 검토할 코드 변경(diff) 또는 파일 묶음이다. 오직 이 내용만 읽기전용으로 검토하라.\n' +
  '버그·보안·품질 위주 핵심 지적만, 우선순위 높은 것부터. 저장소나 디스크의 다른 어떤 파일도 열거나 ' +
  '읽지 말고(특히 .env·키 등 비밀파일), 어떤 파일도 수정·실행하지 마라. 한국어로 간결하게.';

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const cwd = process.cwd();
  if (!isGitRepo(cwd)) fail('git 저장소가 아니다. 교차검토는 git 저장소에서 실행하라.');

  // 1) 검토 대상(payload) 구성
  const built = opts.paths.length
    ? buildPathPayload(cwd, opts.paths)
    : buildDiffPayload(cwd, opts.base);
  if (!built.payload) fail(built.error || '검토할 내용이 없다.');

  // 2) 도구 병렬 실행(읽기전용). 도구는 저장소 밖 '빈 임시 cwd' 에서 돌린다 — 모델이 주변 파일을
  //    탐색하다 비밀을 끌어오는 표면을 줄인다. (주의: 절대경로 직접 읽기까지 막는 하드 차단은 아니다.
  //    그건 OS 샌드박스 영역 — README '잔여 리스크' 참고.)
  let toolCwd;
  try { toolCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-xr-')); }
  catch { toolCwd = cwd; }                              // 임시디렉터리 실패 시 원 cwd 로 폴백
  // 격리 실제 적용 여부(메타에 정직히 표시). TMPDIR 이 repo 안으로 잡히면 '저장소 밖'이 아니므로 격리로 치지 않는다.
  const repoPrefix = path.resolve(cwd) + path.sep;
  const createdTemp = toolCwd !== cwd;
  const isolated = createdTemp && !path.resolve(toolCwd).startsWith(repoPrefix);
  const isoLabel = isolated ? '임시 cwd'
    : createdTemp ? '없음(TMPDIR이 저장소 내부)'
    : '없음(임시디렉터리 생성 실패→원 cwd)';

  // 정리: 도구 자식 프로세스 그룹 kill + 임시디렉터리 삭제. 정상/예외/시그널 모두 커버.
  const killAll = () => { for (const c of activeChildren) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* 무시 */ } } } };
  const cleanup = () => { if (createdTemp) { try { fs.rmSync(toolCwd, { recursive: true, force: true }); } catch { /* 무시 */ } } };
  process.once('SIGINT', () => { killAll(); cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { killAll(); cleanup(); process.exit(143); });

  const tools = [];
  if (opts.tools.includes('gemini')) {
    tools.push(runTool('GEMINI', 'gemini',
      ['--approval-mode', 'plan', '--skip-trust', '-p', INSTRUCTION, '-o', 'text'],
      built.payload, opts.timeout, toolCwd));
  }
  if (opts.tools.includes('codex')) {
    tools.push(runTool('CODEX', 'codex',
      ['exec', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--ignore-rules', '--ignore-user-config', '--ephemeral', INSTRUCTION],
      built.payload, opts.timeout, toolCwd));
  }

  Promise.all(tools).then((results) => {
    process.stdout.write(render(built, results, opts, isoLabel));
  }).finally(cleanup);
}

// ── 인자 파싱 ──
function parseArgs(argv) {
  const o = { base: null, timeout: PER_TOOL_TIMEOUT_MS_DEFAULT, tools: ['gemini', 'codex'], paths: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--timeout') o.timeout = Math.max(10, parseInt(argv[++i], 10) || 180) * 1000;
    else if (a === '--tools') {
      const req = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = req.filter((t) => t !== 'gemini' && t !== 'codex');
      if (bad.length || !req.length) fail(`--tools 는 gemini|codex 만 (입력: "${req.join(',')}")`);
      o.tools = req;
    }
    else if (a === '--') o.paths.push(...argv.slice(i + 1)), (i = argv.length);
    else if (a.startsWith('-')) fail(`알 수 없는 옵션: ${a}`);
    else o.paths.push(a);
  }
  return o;
}

function printHelp() {
  process.stdout.write(
    'phoenix-flow cross-review — gemini+codex 읽기전용 교차검토\n\n' +
    '사용법:\n' +
    '  node cross-review.js                  # 현재 브랜치 diff(base 대비) 교차검토\n' +
    '  node cross-review.js --base main      # base 브랜치 지정\n' +
    '  node cross-review.js src/ a.js        # 지정 경로(git tracked 텍스트만) 교차검토\n\n' +
    '옵션:\n' +
    '  --base <ref>      diff 기준 ref (기본: origin/HEAD→main→master)\n' +
    '  --tools <list>    실행 도구 (기본: gemini,codex)\n' +
    '  --timeout <sec>   도구별 타임아웃 (기본: 180)\n');
}

// ── git 헬퍼 ──
function git(args, cwd, maxBuffer = MAX_OUTPUT_BYTES) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });
}
function gitQuiet(args, cwd) { try { return git(args, cwd).trim(); } catch { return null; } }
function isGitRepo(cwd) { return gitQuiet(['rev-parse', '--is-inside-work-tree'], cwd) === 'true'; }

function resolveBase(explicit, cwd) {
  if (explicit) return explicit;
  const head = gitQuiet(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
  if (head) return head.replace(/^refs\/remotes\//, '');
  for (const b of ['origin/main', 'origin/master', 'main', 'master', 'develop']) {
    if (gitQuiet(['rev-parse', '--verify', '--quiet', b], cwd) !== null) return b;
  }
  return null;
}

// ── diff 모드: base 대비 변경 + untracked(비-ignore) 신규 파일 ──
function buildDiffPayload(cwd, baseOpt) {
  const base = resolveBase(baseOpt, cwd);
  if (!base) return { error: 'diff 기준 ref 를 찾지 못했다. --base 로 지정하라.' };
  const mergeBase = gitQuiet(['merge-base', 'HEAD', base], cwd) || base;

  let diff = '';
  try {
    diff = git(['--no-pager', '-c', 'color.ui=false', 'diff', '--no-ext-diff', mergeBase, '--'], cwd, GIT_DIFF_MAXBUF);
  } catch (e) {
    return { error: `git diff 실패: ${String(e.message || e).split('\n')[0]}` };
  }

  const parts = [];
  let total = 0;
  if (diff.trim()) { parts.push(diff); total += Buffer.byteLength(diff); }

  // untracked(.gitignore 존중) 신규 파일도 리뷰 대상에 포함 — git 이 아는 것만이라 .env 등은 빠진다
  const untracked = (gitQuiet(['ls-files', '--others', '--exclude-standard', '-z'], cwd) || '')
    .split('\0').filter(Boolean);
  const notes = [];
  for (const rel of untracked) {
    if (total >= MAX_PAYLOAD_BYTES) { notes.push(`(상한 초과로 일부 untracked 생략)`); break; }
    const f = readReviewable(cwd, rel);
    if (f.skip) { notes.push(`skip ${rel}: ${f.skip}`); continue; }
    const block = `\n===== NEW FILE: ${rel} =====\n${f.content}\n`;
    parts.push(block); total += Buffer.byteLength(block);
  }

  if (!parts.length) return { error: `base(${base}) 대비 변경이 없다.` };
  return {
    payload: clamp(parts.join('')),
    targetDesc: `diff vs ${base} (merge-base ${short(mergeBase)})`,
    notes,
  };
}

// ── 경로 모드: git tracked 텍스트 파일만 ──
function buildPathPayload(cwd, paths) {
  const tracked = (gitQuiet(['ls-files', '-z', '--', ...paths], cwd) || '').split('\0').filter(Boolean);
  if (!tracked.length) return { error: `지정 경로에 git tracked 파일이 없다: ${paths.join(' ')} (untracked/ignored 는 제외)` };

  const parts = [];
  const notes = [];
  let total = 0;
  for (const rel of tracked) {
    if (total >= MAX_PAYLOAD_BYTES) { notes.push(`(상한 ${MAX_PAYLOAD_BYTES}B 초과로 이후 파일 생략)`); break; }
    const f = readReviewable(cwd, rel);
    if (f.skip) { notes.push(`skip ${rel}: ${f.skip}`); continue; }
    const block = `\n===== FILE: ${rel} =====\n${f.content}\n`;
    parts.push(block); total += Buffer.byteLength(block);
  }
  if (!parts.length) return { error: '검토 가능한 텍스트 파일이 없다(바이너리/대용량/symlink 제외됨).' };
  return { payload: clamp(parts.join('')), targetDesc: `paths: ${paths.join(' ')} (${parts.length} files)`, notes };
}

// 파일 1개를 검토 대상으로 읽기 — 민감파일명/저장소밖/symlink/바이너리/대용량 차단
function readReviewable(cwd, rel) {
  if (SENSITIVE_RE.test(rel)) return { skip: '민감 파일명(차단)' };
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return { skip: '경로 형식 거부' };
  const abs = path.resolve(cwd, rel);
  const relCheck = path.relative(cwd, abs);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return { skip: '저장소 밖 경로' };
  let st;
  try { st = fs.lstatSync(abs); } catch { return { skip: '읽기 실패' }; }
  if (st.isSymbolicLink()) return { skip: 'symlink' };
  if (!st.isFile()) return { skip: '일반 파일 아님' };
  if (st.size > MAX_FILE_BYTES) return { skip: `${st.size}B > ${MAX_FILE_BYTES}B` };
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return { skip: '읽기 실패' }; }
  if (buf.subarray(0, TEXT_SNIFF_BYTES).includes(0)) return { skip: '바이너리' };
  return { content: buf.toString('utf8') };
}

function clamp(s) {
  if (Buffer.byteLength(s) <= MAX_PAYLOAD_BYTES) return s;
  return Buffer.from(s).subarray(0, MAX_PAYLOAD_BYTES).toString('utf8') +
    `\n\n[... 검토 대상이 ${MAX_PAYLOAD_BYTES}B 를 초과해 잘림 ...]`;
}

// ── 도구 실행(spawn + 타임아웃 + process-group kill) ──
function runTool(label, bin, args, payload, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(bin, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ label, bin, status: 'error', exitCode: null, ms: 0, stdout: '', stderr: String(e.message || e) });
    }
    activeChildren.add(child);
    const settle = (r) => { activeChildren.delete(child); resolve(r); };

    let out = Buffer.alloc(0), err = Buffer.alloc(0), outCut = false, errCut = false, timedOut = false;
    const cap = (cur, chunk, cut) => {
      if (cut.v) return cur;
      const next = Buffer.concat([cur, chunk]);
      if (next.length > MAX_OUTPUT_BYTES) { cut.v = true; return next.subarray(0, MAX_OUTPUT_BYTES); }
      return next;
    };
    const oc = { v: false }, ec = { v: false };
    child.stdout.on('data', (d) => { out = cap(out, d, oc); outCut = oc.v; });
    child.stderr.on('data', (d) => { err = cap(err, d, ec); errCut = ec.v; });

    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 3000).unref();
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      settle({ label, bin, status: 'error', exitCode: null, ms: Date.now() - start, stdout: out.toString('utf8'), stderr: String(e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = out.toString('utf8') + (outCut ? '\n[... 출력 상한 초과로 잘림 ...]' : '');
      const stderr = err.toString('utf8') + (errCut ? '\n[... 잘림 ...]' : '');
      let status = 'ok';
      if (timedOut) status = 'timeout';
      else if (code !== 0) status = 'error';
      else if (!stdout.trim()) status = 'empty';
      settle({ label, bin, status, exitCode: code, ms: Date.now() - start, stdout, stderr });
    });

    // 검토 대상은 stdin 으로만 주입(ARG_MAX 회피). 끝에 EOF — codex 는 stdin EOF 를 기다리므로 필수.
    child.stdin.on('error', () => {});
    child.stdin.write(payload);
    child.stdin.end();
  });
}

// ── 출력(도구별 구분 — 종합은 메인 Claude 가) ──
function render(built, results, opts, isoLabel) {
  const lines = [];
  lines.push(`===== CROSS-REVIEW =====`);
  lines.push(`대상: ${built.targetDesc} | 입력 ${Buffer.byteLength(built.payload)}B | 도구: ${opts.tools.join(', ')} | 격리: ${isoLabel}`);
  if (built.notes && built.notes.length) lines.push(`주의: ${built.notes.join(' | ')}`);
  lines.push('');

  for (const r of results) {
    lines.push(`===== ${r.label} (status=${r.status}, ${(r.ms / 1000).toFixed(1)}s, exit=${r.exitCode}) =====`);
    if (r.status === 'ok' || r.stdout.trim()) lines.push(r.stdout.trimEnd());
    if (r.status !== 'ok') {
      const reason = { timeout: '타임아웃', error: '실행 실패/비정상 종료', empty: '출력 없음' }[r.status] || r.status;
      lines.push(`[${reason}] ${r.stderr.trim().split('\n').slice(-3).join(' ') || ''}`.trim());
    }
    lines.push('');
  }

  lines.push('===== 종합 안내 =====');
  lines.push('위 GEMINI/CODEX 원문을 메인 Claude 가 합의점·상충점·우선순위로 통합하라.');
  return lines.join('\n') + '\n';
}

function short(ref) { return (ref || '').slice(0, 12); }
function fail(msg) { process.stderr.write(`[cross-review] ${msg}\n`); process.exit(1); }

main();
