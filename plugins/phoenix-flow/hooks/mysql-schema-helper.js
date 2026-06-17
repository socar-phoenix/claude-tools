#!/usr/bin/env node
// phoenix-flow: mysql 스키마 인지 헬퍼 (PostToolUseFailure hook)
//
// mysql 쿼리가 실패하면(특히 ERROR 1054 컬럼 없음 / 1146 테이블 없음),
// 쿼리에 등장한 테이블의 "실제 컬럼 목록"과 "유사 테이블명"을 조회해
// Claude 컨텍스트로 주입한다. 추측 컬럼/테이블 반복 실패를 줄이는 것이 목적.
//
// 안전 원칙(보수적 — 틀린 스키마를 주입하느니 아무것도 안 한다):
//  - 원본 SQL 은 절대 재실행하지 않는다. SHOW COLUMNS / SHOW TABLES 읽기만.
//  - 접속 옵션/DB 는 "원 명령의 mysql argv"에서만 파싱한다. SQL 본문 텍스트는 보지 않는다
//    (SQL 안의 --host=... 같은 문자열에 오염되면 엉뚱한 DB 스키마를 주입할 수 있음).
//  - 재현 불가/모호하면 즉시 포기: docker|ssh|kubectl exec mysql, 파이프·리다이렉션,
//    --login-path / --defaults-file, 인터랙티브 -p(값 없는 비번).
//  - 어떤 단계든 실패/모호하면 조용히 통과(exit 0). hook 은 작업을 막지 않는다.

const { execFileSync } = require('child_process');

const DEADLINE = Date.now() + 6500;          // 전역 마감(누적 timeout 방지)
const MAX_TABLES = 5;                         // 조회 테이블 수 상한
const MAX_COLS = 60;                          // 표시 컬럼 수 상한
const MAX_SIMILAR = 10;                       // 유사 테이블 수 상한

const done = () => process.exit(0);

// 따옴표 구간을 한 토큰으로 보존하는 shell-lite 토크나이저
function tokenize(s) {
  return s.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g) || [];
}

// 명령을 세그먼트로 쪼개 "mysql 을 직접 호출하는" argv 를 찾는다. 없거나 모호하면 null.
function findMysqlArgv(cmd) {
  for (const seg of cmd.split(/&&|\|\||;/)) {
    const toks = tokenize(seg.trim());
    if (!toks.length) continue;
    let i = 0;
    while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i])) i++;   // VAR=val prefix skip
    const head = toks[i] || '';
    if (head === 'mysql' || /\/mysql$/.test(head)) {
      if (/[|<>]/.test(seg)) return null;                            // 파이프·리다이렉션 → 포기
      return toks.slice(i);
    }
    if (['docker', 'ssh', 'kubectl', 'podman', 'eval'].includes(head)) return null; // 원격/래핑 → 포기
  }
  return null;
}

// argv → {opts[], db}. 재현 불가 옵션이면 null.
function parseConn(argv) {
  const opts = [];
  let db = '';
  const longKeep = /^--(host|user|port|socket|database|protocol|defaults-group-suffix|default-character-set)=/;
  const longAbort = ['--login-path', '--defaults-file', '--defaults-extra-file'];
  for (let i = 1; i < argv.length; i++) {
    const tk = argv[i];
    if (tk === '-e' || tk === '--execute') break;                   // SQL 시작 → 접속부 끝
    if (tk[0] === '"' || tk[0] === "'") break;                      // 인용 SQL
    if (longAbort.some((a) => tk === a || tk.startsWith(a + '='))) return null;
    if (longKeep.test(tk) || tk === '--protocol') { opts.push(tk); continue; }
    // 비밀번호: 값 붙은 -pXXX / --password=XXX 는 보존, 값 없는 -p/--password 는 인터랙티브 → 포기
    if (tk === '-p' || tk === '--password') return null;
    if (/^-p./.test(tk) || tk.startsWith('--password=')) { opts.push(tk); continue; }
    // 값 갖는 짧은 옵션: -h -u -P -S -D (붙음/분리 모두)
    const m = tk.match(/^-([hHuPSD])(.*)$/);
    if (m) {
      if (m[2]) opts.push(tk);                                      // -uroot
      else { const v = argv[i + 1]; if (v !== undefined) { opts.push(tk, v); i++; } }  // -u root
      continue;
    }
    if (tk[0] === '-') { opts.push(tk); continue; }                 // -N -t 등 무해 플래그
    if (!db) db = tk;                                               // 첫 positional = DB
  }
  return { opts, db };
}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(input); } catch { return done(); }
  if (ev.tool_name !== 'Bash') return done();
  const cmd = (ev.tool_input && ev.tool_input.command) || '';
  if (!/\bmysql\b/.test(cmd)) return done();

  const argv = findMysqlArgv(cmd);
  if (!argv) return done();
  const conn = parseConn(argv);
  if (!conn) return done();

  const runMeta = (sql) => {
    const remain = DEADLINE - Date.now();
    if (remain < 600) return null;                                  // 남은 시간 없으면 포기
    try {
      const args = conn.opts.concat(conn.db ? [conn.db] : [], ['-N', '-B', '-e', sql]);
      return execFileSync('mysql', args, {
        timeout: Math.min(4000, remain), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
      });
    } catch { return null; }
  };

  // 쿼리에서 테이블명 추출 (db.table 또는 table). SQL 본문은 메타조회에 쓰지 않고 이름만 뽑는다.
  const tables = [];
  const seen = new Set();
  const tre = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([`"]?[A-Za-z_]\w*[`"]?(?:\.[`"]?[A-Za-z_]\w*[`"]?)?)/gi;
  let m;
  while ((m = tre.exec(cmd)) && tables.length < MAX_TABLES) {
    const name = m[1].replace(/[`"]/g, '');
    if (!seen.has(name)) { seen.add(name); tables.push(name); }
  }
  if (!tables.length) return done();

  const lines = [];
  for (const t of tables) {
    if (Date.now() > DEADLINE - 600) break;
    let dbPrefix = '', tbl = t;
    if (t.includes('.')) [dbPrefix, tbl] = t.split('.');
    const fq = dbPrefix ? `\`${dbPrefix}\`.\`${tbl}\`` : `\`${tbl}\``;

    const cols = runMeta(`SHOW COLUMNS FROM ${fq}`);
    if (cols && cols.trim()) {
      const all = cols.trim().split('\n').map((r) => {
        const c = r.split('\t');
        return c[1] ? `${c[0]}(${c[1]})` : c[0];
      });
      const shown = all.slice(0, MAX_COLS).join(', ') + (all.length > MAX_COLS ? ` … (+${all.length - MAX_COLS})` : '');
      lines.push(`• ${t} 실제 컬럼: ${shown}`);
    } else {
      const fromDb = dbPrefix ? `FROM \`${dbPrefix}\`` : '';
      const like = tbl.replace(/[^\w]/g, '');
      // 오타 테이블명 전체로 LIKE 하면 원본을 못 찾으므로(access_systemX → access_system),
      // 4자 초과면 앞 70%만으로 접두 부분매칭한다.
      const likeKey = like.length > 4 ? like.slice(0, Math.ceil(like.length * 0.7)) : like;
      const similar = runMeta(`SHOW TABLES ${fromDb} LIKE '%${likeKey}%'`);
      if (similar && similar.trim()) {
        const names = similar.trim().split('\n').slice(0, MAX_SIMILAR).join(', ');
        lines.push(`• ${t} 없음 → 유사 테이블: ${names}`);
      }
    }
  }

  if (!lines.length) return done();

  const additionalContext =
    '[phoenix-flow] mysql 스키마 확인 — 추측 말고 아래 실제 스키마로 다시 쿼리하세요:\n' +
    lines.join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext },
  }));
  done();
});
