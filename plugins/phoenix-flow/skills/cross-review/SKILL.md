---
name: cross-review
description: Use when 코드 변경/PR/특정 파일을 gemini·codex 두 AI에게 동시에 교차검토(cross-review)시키고 결과를 종합할 때. "교차검토 / cross-review / gemini codex 같이 리뷰 / 두 AI 의견 들어봐" 같은 요청에 사용. 두 도구를 읽기전용으로 강제 실행하고(yolo/쓰기 차단) 결과를 한 통합 리뷰로 합친다.
---

# AI 교차검토 (읽기전용)

gemini 와 codex 를 **읽기전용으로 병렬 실행**해 코드 변경/파일을 교차검토하고, 두 결과를 **합의점·상충점·우선순위**로 통합한다.

## 언제

- "이 변경 교차검토해줘", "gemini·codex 둘 다 의견 들어보자", "PR 리뷰 두 AI로"
- 한쪽 AI 의견만으로 불안할 때, 보안/버그를 다각도로 보고 싶을 때

## 읽기전용 보장 (왜 래퍼를 거치나)

직접 `gemini`/`codex` 를 부르지 말고 **반드시 이 스크립트를 거친다**. 이유:

- `gemini` 는 쉘 alias 가 `--approval-mode=yolo`(전부 자동승인)로 묶여 있다. 스크립트는 바이너리를 직접 spawn 해 alias 를 우회하고 `--approval-mode plan`(읽기전용)을 강제한다.
- `codex` 는 `exec --sandbox read-only` 로 쓰기를 막는다.
- 검토 대상은 git 기준(diff + non-ignored untracked / 경로 모드는 tracked 텍스트)으로 stdin 주입한다. `.gitignore` 된 `.env`·키·`node_modules` 는 안 들어가고, 추가로 민감 파일명(`.env*`·`*.pem`·`*.key` 등)·바이너리·대용량·symlink 도 차단한다.

## 실행

```bash
# 현재 브랜치 변경분(base 대비 diff) 교차검토 — 기본
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-review.js"

# base 지정
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-review.js" --base main

# 특정 경로(git tracked 텍스트만)
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-review.js" src/ path/to/file.js

# 한 도구만 / 타임아웃 조정
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-review.js" --tools codex --timeout 240
```

각 도구는 1~3분 걸릴 수 있다. 스크립트가 끝나면 `===== GEMINI =====` / `===== CODEX =====` 로 구분된 원문이 나온다.

## 종합 (이 부분이 메인 Claude 의 일)

스크립트 출력의 두 원문을 읽고 사용자에게 **통합 리뷰** 하나로 정리한다:

1. **합의점** — 두 도구가 같이 지적한 것 (우선순위 최상, 거의 진짜 문제)
2. **상충/단독** — 한쪽만 지적했거나 의견이 갈린 것 (판단 근거를 덧붙여 취사)
3. **우선순위** — 버그·보안 > 품질·스타일 순으로 정렬, 실행 가능한 형태로
4. 한 도구가 `status=timeout/error/empty` 면 그 사실을 명시하고 나머지 결과로 진행

원문을 그대로 붙여넣지 말고 **종합한 결론**을 전달한다(외부 도구 톤을 사용자 응답 톤으로 풀어쓴다).
