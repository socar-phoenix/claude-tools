# claude-tools 마켓플레이스 + phoenix-flow 껍데기 설계

- 날짜: 2026-06-17
- 작성: socar-phoenix
- 상태: 설계 확정 (구현 대기)

## 1. 목적

여러 Claude Code 도구를 **중립 이름의 통합 마켓플레이스 하나**에 담는다. 도구마다 마켓플레이스를 따로 만들면(마켓플레이스 1개당 플러그인 1개) 마켓플레이스 이름이 그 플러그인 이름에 갇혀, 다른 도구를 같은 곳에 진열할 수 없는 문제가 생긴다. `claude-tools`라는 카탈로그를 만들어 여러 플러그인을 진열한다.

이번 작업은 그 마켓플레이스의 **껍데기 + 첫 플러그인 `phoenix-flow`의 빈 뼈대**까지다. phoenix-flow의 실제 기능은 이후 각자 별도 사이클(설계→구현)로 하나씩 채운다.

## 2. 범위

### 이번에 하는 것
- 로컬에 `claude-tools/` repo 디렉터리 구조 생성
- `marketplace.json` (phoenix-flow 1개 등록)
- `phoenix-flow` 플러그인 빈 뼈대 (`plugin.json` + 빈 슬롯)
- `claude plugin validate --strict` 통과
- `git init` + 첫 커밋

### 이번에 하지 않는 것 (다음 단계)
- phoenix-flow 실제 기능 3종 구현 (아래 로드맵)
- 기존에 따로 배포 중인 다른 플러그인을 이 마켓플레이스로 이주
- 이미 사용자가 있는 기존 공개 플러그인은 기존 마켓플레이스 그대로 유지 (이주 대상 아님)

### phoenix-flow 기능 로드맵 (향후, 반복 작업 패턴 기반)
실제 작업 로그에서 반복 빈도가 가장 높은 흐름을 도구로 묶는다.
1. **API 테스트 러너** — 반복되는 `curl` + 응답 확인 흐름을 케이스 정의 한 번으로. (스킬 + MCP)
2. **cd·gh 재시도 자동 교정** — 자주 가는 경로 점프 + `gh` 명령 실패 진단·재시도. (hook, 무개입)
3. **조회 헬퍼** — 반복되는 파일 읽기→grep 흐름을 정해진 조회로. (스킬)

## 3. 디렉터리 구조

```
claude-tools/
├── .claude-plugin/
│   └── marketplace.json          # 카탈로그 정의 (repo root엔 이 파일만)
├── plugins/
│   └── phoenix-flow/             # 플러그인 source root (self-contained)
│       ├── .claude-plugin/
│       │   └── plugin.json        # 최소 필드만
│       ├── skills/.gitkeep        # → 러너·조회 헬퍼 자리
│       ├── hooks/.gitkeep         # → cd·gh 재시도 교정 자리
│       ├── scripts/.gitkeep       # → 실행 스크립트 자리
│       └── README.md
├── docs/
│   └── specs/                     # 설계 문서
├── .gitignore
└── README.md
```

## 4. 핵심 설계 결정 (codex·gemini 세컨드 오피니언 반영)

1. **`plugin.json`은 각 플러그인의 `.claude-plugin/` 안에 둔다.** `claude plugin validate`가 `<plugin-dir>/.claude-plugin/plugin.json`이 없으면 그 폴더를 플러그인으로 인정하지 않는다. `phoenix-flow/plugin.json`(바로 밑)은 레거시 배치.
2. **`plugins/` 계층을 둔다.** 공식 repo 관례(`source: "./plugins/<name>"`)를 따른다. 여러 플러그인을 오래 담을 계획이라 루트에 펼치는 것보다 확장성이 좋다.
3. **실행 컴포넌트는 전부 플러그인 source root 안에.** repo root `.claude-plugin/`엔 `marketplace.json`만. (이전 플러그인 운영 중 실행 컴포넌트를 repo root에 둬서 cache 복사 누락으로 조용히 실패한 사고를 회피)
4. **`plugin.json`은 빈 껍데기 단계에서 최소 필드만** (`name`·`version`·`description`·`author`). `hooks`·`mcpServers`·`commands`·`agents` 경로 필드는 실제 파일이 생긴 뒤에 추가. 빈 슬롯에 경로 필드를 박으면 자동탐색이 꼬인다.
5. **version은 `plugin.json`과 marketplace 항목 양쪽 동일.** `claude plugin tag`가 불일치를 검사.
6. **각 플러그인은 self-contained.** 플러그인 실행 환경은 자기 source root 밖(예: repo 최상위 `shared/`)을 런타임에 참조하지 못한다.

## 5. 파일 내용

### `.claude-plugin/marketplace.json`
> `$schema`는 Claude Code가 로드 시 무시하므로 넣지 않는다. 에디터 자동완성이 필요해지면 그때 schemastore 계열 URL을 추가한다.
```json
{
  "name": "claude-tools",
  "description": "socar-phoenix Claude Code 도구 모음",
  "owner": { "name": "socar-phoenix" },
  "plugins": [
    {
      "name": "phoenix-flow",
      "description": "반복 작업 자동화 (API 테스트·재시도 교정·조회 헬퍼)",
      "version": "0.1.0",
      "author": { "name": "socar-phoenix" },
      "category": "development",
      "source": "./plugins/phoenix-flow"
    }
  ]
}
```

### `plugins/phoenix-flow/.claude-plugin/plugin.json`
```json
{
  "name": "phoenix-flow",
  "version": "0.1.0",
  "description": "반복 작업 자동화 (API 테스트·재시도 교정·조회 헬퍼)",
  "author": { "name": "socar-phoenix" }
}
```

## 6. 검증

첫 커밋 전 (repo root = `claude-tools/`에서 실행):
```bash
claude plugin validate --strict .
claude plugin validate --strict plugins/phoenix-flow
```
실패 시 수정 후 재검증(최대 10회 루프). 통과해야 커밋.

`validate`는 manifest 스키마 통과만 보장하고, 설치 캐시 복사·상대 `source` 해석까지는 보장하지 않는다. 따라서 **배포(원격 push) 단계**에서는 로컬 마켓플레이스 add/install smoke test를 별도로 추가한다. 이번 범위(로컬 뼈대)에서는 `validate` 2개까지만 한다.

## 7. 향후 다른 플러그인 이주 시 주의 (별도 사이클에서 처리)

기존에 단일 플러그인 마켓플레이스로 따로 배포 중인 플러그인을 이 카탈로그로 옮길 때:

1. **manifest 위치 확인 필수.** 플러그인 폴더에 `plugin.json`만 있고 `.claude-plugin/plugin.json`이 없으면 `claude plugin validate --strict <plugin-dir>`(source root 직접 검증)가 **실패**한다. 이주 시 `<plugin-dir>/.claude-plugin/plugin.json`으로 옮긴 뒤 source root를 직접 validate한다. (marketplace validate만으론 못 잡는다)
2. **disable/uninstall은 필수 단계.** 같은 플러그인이 옛 마켓플레이스와 새 마켓플레이스 양쪽에 설치되면, 설치 항목은 달라도 `plugin.json`의 `name` 기준으로 컴포넌트 namespace(MCP 서버·hook·skill)가 충돌할 수 있다. 동시 enable 금지.
3. **로컬 캐시 purge.** uninstall 후에도 기존 마켓플레이스 출신 캐시가 남아 새 소스와 충돌할 수 있다. 이주 가이드에 캐시 물리 삭제 단계를 포함한다.
