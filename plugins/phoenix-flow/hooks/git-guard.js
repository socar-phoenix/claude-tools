#!/usr/bin/env node
// phoenix-flow: Git 권한·브랜치 가드 (PreToolUse hook) — v2
//
// 목적: Claude/subagent 의 무심한 git 사고를 미리 막는 "방어층 하나".
//   ⚠️ 보안 경계가 아니다. 최종 방어선은 GitHub branch protection 이다.
//   원칙: parser 가 확실히 해석 못 하는 shell 구조에서 git/gh write 가 의심되면 fail-closed(deny).
//
// 정책:
//   - subagent (입력에 agent_id/agent_type): git/gh 의 모든 write 차단(read-only allowlist).
//   - 메인 세션:
//       · 보호브랜치에서 직접 commit/merge/reset/rebase/cherry-pick/revert/am/pull 차단
//       · 보호브랜치로 가는 push / ref 변경(branch -f, update-ref, push :main, checkout -B 등) 차단
//       · 같은 명령에서 보호브랜치로 switch/checkout 후 write → 차단(체이닝)
//       · gh pr merge / gh api ...pulls/.../merge / graphql mergePullRequest 차단
//       · --no-verify, -c core.hooksPath=… (hook 우회) 차단
//       · 'git merge main' (보호브랜치를 현재 feature 로 동기화)은 허용 — 목적지로 판별
//   - 해석 불가 + git/gh write 의심 → deny(fail-closed)

const { execFileSync } = require('child_process');

const HARD = setTimeout(() => process.exit(0), 7000);
HARD.unref();

const PROTECTED_DEFAULT = ['main', 'master', 'develop', 'production'];

// 항상 write (state-mutating)
const GIT_WRITE = new Set([
  'commit', 'merge', 'push', 'pull', 'rebase', 'cherry-pick', 'revert', 'am', 'apply',
  'reset', 'restore', 'checkout', 'switch', 'clean', 'add', 'rm', 'mv', 'stash',
  'update-ref', 'update-index', 'write-tree', 'commit-tree', 'fast-import',
  'gc', 'prune', 'repack', 'notes', 'replace', 'filter-branch', 'filter-repo',
]);
// 인자에 따라 write 인 서브커맨드
const GIT_COND_WRITE = new Set(['branch', 'tag', 'remote', 'config', 'worktree']);
// 보호브랜치 "현재 위치"에서 이력을 만드는 서브커맨드
const HISTORY_WRITE = new Set(['commit', 'merge', 'reset', 'rebase', 'cherry-pick', 'revert', 'am', 'pull']);
// shell 구문에서 write 를 의심하는 단어
const WRITE_WORDS = /\b(push|pull|merge|commit|reset|rebase|cherry-pick|revert|\bam\b|update-ref|fast-import|filter-branch|pr\s+merge|pr\s+create|release\s+(create|delete))\b|branch\s+-[a-zA-Z]*[dfDM]/;

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(input); } catch { return allow(); }
  if (ev.tool_name !== 'Bash') return allow();
  const cmd = (ev.tool_input && ev.tool_input.command) || '';
  if (!/\b(git|gh)\b/.test(cmd)) return allow();

  const isSubagent = !!(ev.agent_id || ev.agent_type);
  const baseCwd = ev.cwd || process.cwd();
  const segments = cmd.split(/\n|&&|\|\||;|\|/);

  // 1) 같은 명령에서 보호브랜치로 switch/checkout 하는가? (체이닝 — 이후 write 는 보호브랜치에서 일어남)
  let movesToProtected = false;
  let runningCwd = baseCwd;
  for (const seg of segments) {
    if (checkoutToProtected(seg, runningCwd)) movesToProtected = true;
    const nc = cdTarget(seg, runningCwd);
    if (nc) runningCwd = nc;
  }

  // 2) 세그먼트별 검사 (cd 추적하며 cwd 갱신)
  runningCwd = baseCwd;
  for (const seg of segments) {
    const verdict = inspectSegment(seg, { isSubagent, cwd: runningCwd, movesToProtected });
    if (verdict) return deny(verdict);
    const nc = cdTarget(seg, runningCwd);
    if (nc) runningCwd = nc;
  }
  return allow();
});

function allow() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[phoenix-flow git-guard] ${reason}`,
    },
  }));
  process.exit(0);
}

function tokenize(s) {
  return s.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g) || [];
}
const unq = (t) => t.replace(/^['"]|['"]$/g, '');
const stripRef = (r) => unq(r).replace(/^\+/, '').replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');
const cleanHead = (t) => (t || '').replace(/^[({]+/, '').split('/').pop();

// `cd <path>` → 절대경로(best effort)
function cdTarget(seg, cwd) {
  const t = tokenize(seg.trim());
  let i = 0;
  while (i < t.length && /^[A-Za-z_]\w*=/.test(t[i])) i++;
  if (t[i] !== 'cd') return null;
  const p = unq(t[i + 1] || '');
  if (!p || p.startsWith('-')) return null;
  if (p.startsWith('/')) return p;
  if (p === '~') return process.env.HOME || cwd;
  return require('path').resolve(cwd, p);
}

// `git [opts] (checkout|switch) [-B|-C] <protected>` 인가
function checkoutToProtected(seg, cwd) {
  const t = tokenize(seg.trim());
  let i = 0;
  while (i < t.length && (/^[A-Za-z_]\w*=/.test(t[i]) || ['env', 'command', 'sudo', 'nice', 'nohup', 'time'].includes(t[i]))) i++;
  if (cleanHead(t[i]) !== 'git') return false;
  const g = stripGitGlobals(t.slice(i + 1));
  if (!g) return false;
  if (g.sub !== 'checkout' && g.sub !== 'switch') return false;
  const prot = getProtected(g.cwd || cwd);
  const targets = g.rest.filter((x) => !x.startsWith('-')).map(stripRef);
  return targets.some((b) => prot.includes(b));
}

function inspectSegment(seg, ctx) {
  let toks = tokenize(seg.trim());
  if (!toks.length) return null;

  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z_]\w*=/.test(t)) {
      // GIT_DIR / GIT_WORK_TREE 등으로 대상 repo 가 바뀌면 정확 판별 불가 → write 의심 시 fail-closed
      if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY)=/.test(t) && WRITE_WORDS.test(seg)) {
        return 'GIT_DIR/GIT_WORK_TREE 로 대상 repo 를 바꾸는 git write 는 해석 불가 — 차단(fail-closed).';
      }
      i++; continue;
    }
    if (['env', 'command', 'nice', 'nohup', 'time', 'sudo', 'xargs'].includes(t)) { i++; continue; }
    if (/^(bash|sh|zsh|ksh|dash)$/.test(cleanHead(t))) {
      // bash -c / -lc / -ec 등 안의 git/gh write 는 못 들여다봄 → fail-closed
      const rest = toks.slice(i + 1);
      if (rest.some((x) => /^-[a-z]*c$/.test(x)) && /\b(git|gh)\b/.test(seg) && WRITE_WORDS.test(seg)) {
        return 'shell -c 안의 git/gh write 는 해석 불가 — 차단(fail-closed). 직접 "! 명령"으로 실행하세요.';
      }
      return null;
    }
    break;
  }
  toks = toks.slice(i);
  if (!toks.length) return null;

  const head = cleanHead(toks[0]);                // 괄호/브레이스 prefix 제거
  if (head === 'git') return inspectGit(toks.slice(1).map((x) => x.replace(/[)}]+$/, '')), ctx);
  if (head === 'gh') return inspectGh(toks.slice(1).map((x) => x.replace(/[)}]+$/, '')), ctx);
  return null;
}

// git 전역 옵션 분리 → {sub, rest, cwd, hookBypass}
function stripGitGlobals(args) {
  let cwd = null, hookBypass = false, j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === '-C') { cwd = unq(args[j + 1] || ''); j += 2; continue; }
    if (a === '-c') {
      const kv = args[j + 1] || '';
      if (/!|alias\.|core\.hookspath/i.test(kv)) hookBypass = true;
      j += 2; continue;
    }
    if (/^--git-dir|^--work-tree|^--namespace/.test(a)) { j++; if (!a.includes('=')) j++; continue; }
    if (['-p', '--paginate', '--no-pager', '--no-replace-objects', '--bare', '--literal-pathspecs'].includes(a)) { j++; continue; }
    break;
  }
  if (j >= args.length) return null;
  return { sub: args[j], rest: args.slice(j + 1), cwd, hookBypass };
}

function inspectGit(args, ctx) {
  const g = stripGitGlobals(args);
  if (!g) return null;
  const { sub, rest } = g;
  const cwd = g.cwd ? require('path').resolve(ctx.cwd, g.cwd) : ctx.cwd;
  const restStr = rest.join(' ');
  const hasRecoveryFlag = rest.some((r) => /^--(abort|continue|skip|quit|edit-todo)$/.test(r));

  // ── subagent: 모든 write 차단(read-only) ──
  if (ctx.isSubagent) {
    if (GIT_WRITE.has(sub)) {
      if ((sub === 'merge' || sub === 'rebase') && hasRecoveryFlag) return null; // 복구 명령은 허용
      return `subagent 는 git write 금지 (git ${sub}). 분석/조회만 — 실제 반영은 메인 세션에서.`;
    }
    if (GIT_COND_WRITE.has(sub) && isCondWrite(sub, rest)) return `subagent 는 git write 금지 (git ${sub} ${restStr}).`;
    return null;
  }

  // ── 메인 세션 ──
  if (g.hookBypass) return `git hook 우회(-c core.hooksPath / alias) 금지.`;
  if ((sub === 'commit' || sub === 'push') && (rest.includes('--no-verify') || (sub === 'commit' && rest.includes('-n')))) {
    return `git ${sub} --no-verify 금지 (pre-commit/pre-push 우회 불가).`;
  }

  const prot = getProtected(cwd);
  const isProt = (b) => prot.includes(b);

  if (sub === 'push') {
    if (rest.includes('--dry-run') || rest.includes('-n')) return null;   // 조회성 push 허용
    const dests = pushDestinations(rest, cwd);
    if (dests === 'UNSURE') return `push 목적지를 확정할 수 없음 (--repo/HEAD/암묵 refspec) — 차단(fail-closed). 명시적으로 'git push origin <feature>' 형태로.`;
    const hit = dests.find((b) => b === '*' || isProt(b));
    if (hit) return `보호 브랜치로 push 금지 (목적지: ${hit === '*' ? '--all/--mirror' : hit}). feature 브랜치 + PR 로.`;
    return null;
  }

  // 보호브랜치 ref 를 강제 이동/생성하는 명령
  if (sub === 'branch' && /\s(-f|--force|-M|-m|-D|-d|--delete)(\s|$)/.test(' ' + restStr + ' ')) {
    if (rest.filter((t) => !t.startsWith('-')).map(stripRef).some(isProt)) return `보호 브랜치 ref 강제 변경 금지 (git branch ${restStr}).`;
  }
  if (sub === 'update-ref' && rest.map(stripRef).some(isProt)) return `보호 브랜치 ref 직접 변경 금지 (git update-ref ${restStr}).`;
  if (((sub === 'checkout' && rest.includes('-B')) || (sub === 'switch' && rest.includes('-C'))) &&
      rest.filter((t) => !t.startsWith('-')).map(stripRef).some(isProt)) {
    return `보호 브랜치 강제 재생성 금지 (git ${sub} ${restStr}).`;
  }

  // 현재 위치(또는 체이닝으로 이동한 보호브랜치)에서 이력을 만드는 명령
  if (HISTORY_WRITE.has(sub)) {
    if (hasRecoveryFlag) return null;                                    // --abort/--continue 등 복구 허용
    if (sub === 'reset' && !isRefMovingReset(rest)) return null;          // 'reset [HEAD] -- <path>' unstage 허용
    const cur = currentBranch(cwd);
    const onProtected = ctx.movesToProtected || (cur && isProt(cur));
    if (onProtected) return `보호 브랜치에서 ${sub} 로 직접 이력 변경 금지 (feature 브랜치 + PR 로).`;
  }
  return null;
}

// reset 이 ref 를 이동시키는가(이력 변경) vs 단순 unstage 인가
function isRefMovingReset(rest) {
  if (rest.some((r) => /^--(hard|soft|mixed|keep|merge)$/.test(r))) return true;
  const positional = rest.filter((r) => !r.startsWith('-'));
  const dashdash = rest.indexOf('--');
  if (dashdash !== -1) return false;                                     // '-- <path>' → unstage
  // positional 이 없으면 'reset'(=mixed HEAD) → 이력 영향 있음
  if (!positional.length) return true;
  // 'reset <commit-ish>' (path 아님) → 이동. 'reset HEAD <path>'(2개+) → unstage 로 간주
  return positional.length === 1;
}

function isCondWrite(sub, rest) {
  const s = ' ' + rest.join(' ') + ' ';
  const READ = /\s(--list|-l|--get|--get-all|--get-regexp|--get-urlmatch|--points-at|--contains|--merged|--no-merged|--show-current|-v|--verbose|-a|-r|--all|-n|--show|get-url)(\s|$)/;
  if (READ.test(s)) return false;
  if (sub === 'branch') return /\s(-d|-D|-f|--force|-m|-M|--delete|--edit-description|--set-upstream|-u)(\s|$)/.test(s);
  if (sub === 'tag') return /\s(-d|--delete|-f|--force|-a|-s|-m)(\s|$)/.test(s) || (rest.filter((t) => !t.startsWith('-')).length > 0 && !/\s-l|\s--list/.test(s));
  if (sub === 'remote') return /\b(add|remove|rm|rename|set-url|set-head|set-branches|prune)\b/.test(s);
  if (sub === 'config') return rest.length > 0;                          // READ 옵션은 위에서 걸러짐
  if (sub === 'worktree') return /\b(add|remove|move|prune)\b/.test(s);
  return false;
}

// push 목적지 브랜치 목록, 또는 '*'(전체), 또는 'UNSURE'(fail-closed)
function pushDestinations(rest, cwd) {
  if (rest.includes('--all') || rest.includes('--mirror')) return ['*'];
  const hasRepoOpt = rest.some((r) => /^(--repo)$/.test(r) || /^--repo=/.test(r));
  const isDelete = rest.includes('--delete') || rest.includes('-d');
  const positional = rest.filter((t, idx) => {
    if (t.startsWith('-')) return false;
    const prev = rest[idx - 1];
    if (prev && /^(-o|--push-option|--repo|-c|--exec|--receive-pack)$/.test(prev)) return false;
    return true;
  });
  // refspec 목록: --repo 가 있으면 positional 전부가 refspec, 아니면 첫 토큰은 remote
  const refspecs = hasRepoOpt ? positional : positional.slice(1);
  if (!refspecs.length) {
    if (isDelete) return 'UNSURE';
    const cur = currentBranch(cwd);
    if (!cur) return 'UNSURE';                                          // detached 등 → 확정 불가
    return [cur];                                                       // push.default=simple/current 가정
  }
  const dests = [];
  for (const rs of refspecs) {
    const v = unq(rs);
    if (v === 'HEAD') { const c = currentBranch(cwd); if (!c) return 'UNSURE'; dests.push(c); continue; }
    if (isDelete) { dests.push(stripRef(v)); continue; }
    if (v.includes(':')) dests.push(stripRef(v.split(':')[1] || ''));
    else dests.push(stripRef(v));
  }
  return dests.filter(Boolean);
}

function inspectGh(args, ctx) {
  // gh 전역 옵션 제거(-R/--repo <v>, --hostname <v> 등)
  const a = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    if (t === '-R' || t === '--repo' || t === '--hostname') { k++; continue; }
    if (/^(--repo|--hostname)=/.test(t)) continue;
    a.push(t);
  }
  const s = a.join(' ');
  if (a[0] === 'pr' && a[1] === 'merge') return 'gh pr merge 금지 — PR 은 승인 후 사용자가 직접 머지하세요.';
  if (a[0] === 'api') {
    if (/pulls\/[^/\s]+\/merge/.test(s)) return 'gh api 로 PR merge 호출 금지 — 승인 후 사용자가 직접.';
    if (/graphql/.test(s) && /mergePullRequest/.test(s)) return 'gh api graphql mergePullRequest 금지.';
  }
  // subagent: gh write 전면 차단(read allowlist 외)
  if (ctx.isSubagent) {
    const sub = a[0], verb = a[1] || '';
    const READ_GH = {
      pr: /^(view|list|status|diff|checks)$/, issue: /^(view|list|status)$/,
      run: /^(view|list)$/, release: /^(view|list)$/, repo: /^(view|list)$/,
      workflow: /^(view|list)$/, browse: /.*/, search: /.*/, label: /^list$/, auth: /^status$/,
    };
    if (sub === 'api') {
      const hasWrite = a.some((x) => /^-X$/.test(x)) || a.some((x) => /^(--method|-f|-F|--input)$/.test(x));
      const method = (a[a.indexOf('-X') + 1] || a[a.indexOf('--method') + 1] || 'GET').toUpperCase();
      if (hasWrite && method !== 'GET') return `subagent 는 gh api write 금지 (${method}).`;
      return null;
    }
    if (READ_GH[sub]) { if (!READ_GH[sub].test(verb)) return `subagent 는 gh ${sub} write 금지 (gh ${sub} ${verb}).`; return null; }
    // 모르는 gh 서브커맨드는 write 가능성 → 차단(fail-closed)
    return `subagent 는 gh write 금지 (gh ${sub} ${verb}).`;
  }
  return null;
}

// ── repo 메타 조회 (캐시) ──
const _branchCache = {};
function currentBranch(cwd) {
  if (cwd in _branchCache) return _branchCache[cwd];
  let b = null;
  try {
    b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim();
    if (b === 'HEAD') b = null;
  } catch { b = null; }
  _branchCache[cwd] = b;
  return b;
}
const _protCache = {};
function getProtected(cwd) {
  if (cwd in _protCache) return _protCache[cwd];
  const set = new Set(PROTECTED_DEFAULT);
  try {
    const head = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim();
    const d = head.replace(/^refs\/remotes\/[^/]+\//, '');
    if (d) set.add(d);
  } catch { /* ignore */ }
  const list = [...set];
  _protCache[cwd] = list;
  return list;
}
