# claude-tools

`socar-phoenix`의 Claude Code 도구 모음 마켓플레이스(카탈로그). 도구마다 마켓플레이스를 따로 차리지 않고, 이 한 곳에 여러 플러그인을 진열한다.

## 설치

```bash
# 마켓플레이스 등록 (원격 push 후 사용 가능)
/plugin marketplace add socar-phoenix/claude-tools

# 플러그인 설치
/plugin install phoenix-flow@claude-tools
```

> 마켓플레이스는 GitHub repo 또는 git URL로 추가해야 한다. raw `marketplace.json` URL로 추가하면 플러그인 파일이 함께 내려오지 않아 실패한다.

## 수록 플러그인

| 플러그인 | 설명 | 버전 |
|----------|------|------|
| [phoenix-flow](plugins/phoenix-flow) | 반복 작업 자동화 (API 테스트·재시도 교정·조회 헬퍼) | 0.1.0 |

## 구조

```
claude-tools/
├── .claude-plugin/marketplace.json   # 카탈로그 정의 (repo root엔 이 파일만)
└── plugins/
    └── phoenix-flow/                 # 플러그인 source root
        └── .claude-plugin/plugin.json
```

실행 컴포넌트(plugin.json·hooks·scripts·.mcp.json)는 전부 각 플러그인 source root(`plugins/<name>/`) 안에 둔다.
