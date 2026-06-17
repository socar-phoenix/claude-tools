# phoenix-flow

반복 작업을 자동화하는 Claude Code 플러그인. 실제 작업 로그(세션 transcript)의 실패 패턴을 분석해, 가장 자주 헛도는 지점을 도구로 잡는다.

> **상태**: 0.4.0

## 기능

### mysql 스키마 인지 교정 (구현됨) — `hooks/`
mysql 쿼리가 실패하면(특히 `ERROR 1054` 없는 컬럼 / `ERROR 1146` 없는 테이블), 쿼리에 등장한 테이블의 **실제 컬럼 목록**과 **유사 테이블명**을 조회해 컨텍스트로 주입한다. 스키마를 추측하다 반복 실패하는 걸 줄인다. `PostToolUseFailure` hook이라 무인 발동.

- 원본 SQL은 재실행하지 않고 `SHOW COLUMNS`/`SHOW TABLES` 읽기만 한다.
- 접속 옵션·DB는 **원 명령의 mysql argv에서만** 파싱한다(SQL 본문 텍스트에 오염되지 않음).
- 재현 불가/모호하면 조용히 포기: `docker|ssh|kubectl exec mysql`, 파이프·리다이렉션, `--login-path`/`--defaults-file`, 인터랙티브 `-p`.
- 운영(`--defaults-group-suffix=_prod`)은 SELECT 권한 범위의 `SHOW`만 쓰므로 안전.

> 선정 근거: 세션 로그 전체 실패 1,046건 중 mysql이 181건(1위)이었고, 그 중 컬럼/테이블을 추측하다 난 `1054`(76)+`1146`(34)=110건이 가장 큰 단일 원인이었다.

### Git 권한·브랜치 가드 (구현됨) — `hooks/`
`PreToolUse` hook으로 무심한 git 사고를 미리 막는다. **방어층 하나일 뿐 — 최종 방어선은 GitHub branch protection이다.**

- **subagent**(입력에 `agent_id`): git/gh의 모든 write 차단(read-only allowlist).
- **메인 세션**: 보호 브랜치(main/master/develop/production + `origin/HEAD`)에서 직접 commit/merge/reset/rebase/cherry-pick/revert/am/pull 차단, 보호 브랜치로 가는 push·ref 변경 차단, `gh pr merge`/`gh api …/merge` 차단, `--no-verify`·`-c core.hooksPath` 차단.
- `git merge main`(보호 브랜치를 feature로 동기화)은 목적지로 판별해 **허용**.
- 원칙: 해석 불가한 shell 구조(`bash -lc`, 괄호구문, `GIT_DIR=`, `cd` 등)에서 write가 의심되면 **fail-closed(차단)**. 우회는 결국 remote protection에 맡긴다.

> 선정 근거: archivist 반복 피드백 1위가 "subagent 무단 머지·보호브랜치 직접 반영" 사고였고, codex·gemini도 ROI 최상으로 꼽음.

### AI 교차검토 읽기전용 래퍼 (구현됨) — `skills/cross-review/`, `scripts/cross-review.js`
gemini·codex 두 AI를 **읽기전용으로 병렬 실행**해 코드 변경/파일을 교차검토하고, 두 결과를 메인 Claude가 **합의점·상충점·우선순위**로 종합한다. "교차검토" 요청 시 skill이 스크립트를 호출한다.

- **읽기전용 강제**: gemini는 `--approval-mode plan`(읽기전용), codex는 `exec --sandbox read-only`. 스크립트가 바이너리를 직접 `spawn`하므로 사용자의 `gemini --approval-mode=yolo` 쉘 alias는 적용되지 않는다.
- **정보유출 방어**: 검토 대상은 git 기준으로 추린다 — diff 모드는 `git diff` + `--exclude-standard`로 거른 **non-ignored untracked 신규 파일**, 경로 모드는 `git ls-files`(tracked)만. `.gitignore`된 `.env`·키·`node_modules`는 입력에 안 들어가고, 추가로 **민감 파일명(`.env*`·`*.pem`·`*.key`·`id_rsa` 등)·바이너리·대용량·symlink·저장소 밖 경로를 한 겹 더 차단**한다(untracked인데 gitignore에도 없는 비밀파일 대비). 도구 내장 ignore엔 의존하지 않는다(검색 숨김 수준이라 직접 읽기엔 약함).
- **견고성**: 검토 대상은 argv가 아니라 stdin 주입(ARG_MAX 회피), `spawn` 스트리밍(maxBuffer 함정 회피), 도구별 타임아웃 + process-group kill(SIGTERM→SIGKILL), 한쪽 실패해도 다른 쪽 결과 반환.

> 선정 근거: 단일 AI 리뷰의 사각을 두 모델 교차로 줄이고, yolo alias로 인한 의도치 않은 쓰기 사고를 원천 차단. 설계 자체를 gemini·codex 읽기전용 교차검토로 검증해(`--approval-mode plan` 존재 확인, `codex exec` stdin EOF hang, ARG_MAX 등) 반영했다.

### 후보 (미구현)
- **조회 헬퍼** — 반복되는 파일 읽기→grep 흐름을 정해진 조회로. (skill)

> "API 테스트 러너"는 별도 내부 repo가 이미 그 역할을 하므로 제외. "cd·gh 재시도 교정"은 실패 데이터상 ROI가 낮아(실제 cd 경로 실패 28건·gh 13건) 보류.

## 디렉터리

| 경로 | 용도 |
|------|------|
| `.claude-plugin/plugin.json` | 플러그인 매니페스트 |
| `hooks/hooks.json` | hook 등록 (PostToolUseFailure → mysql 헬퍼) |
| `hooks/mysql-schema-helper.js` | mysql 스키마 인지 교정 (순수 node, 의존성 0) |
| `hooks/git-guard.js` | git 권한·브랜치 가드 (순수 node, 의존성 0) |
| `skills/cross-review/SKILL.md` | AI 교차검토 스킬 (gemini·codex 읽기전용 → 종합) |
| `scripts/cross-review.js` | 교차검토 실행기 (순수 node, 의존성 0) |

각 플러그인은 self-contained — 실행 컴포넌트는 전부 이 폴더 안에 둔다(source root 밖 참조 불가).
