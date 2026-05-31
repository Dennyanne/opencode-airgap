# Deep Interview Spec: 폐쇄망용 opencode + oh-my-opencode 단일 실행 파일 패키징/업데이트 도구

## Metadata
- Interview ID: di-opencode-airgap-001
- Rounds: 7
- Final Ambiguity Score: 14%
- Type: greenfield
- Generated: 2026-05-29
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.88 | 0.40 | 0.352 |
| Constraint Clarity | 0.86 | 0.30 | 0.258 |
| Success Criteria | 0.82 | 0.30 | 0.246 |
| **Total Clarity** | | | **0.856** |
| **Ambiguity** | | | **0.144** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| 번들/패키징 빌드 파이프라인 | active | opencode 코어 + oh-my-opencode + 로컬 런타임 의존성(MCP/LSP/ast-grep)을 단일 Windows .exe로 임베드 | Goal/Constraints/Criteria 모두 다룸 (R1~R5) |
| 업데이트 & 재번들 명령 | active | 인터넷 머신에서 최신 opencode/플러그인을 가져와 새 단일 exe를 생성하는 CLI 명령 | 버전 정책=항상 최신 확정 (R6) |
| 런타임 구성 (config 파일) | active | 패키징된 exe가 vLLM OpenAI 호환 엔드포인트에 연결되도록 config 파일로 설정 | config 파일 방식 확정 (R0) |
| 폐쇄망 전달(air-gap delivery) | deferred | 완성된 exe를 폐쇄망으로 옮기는 과정 | 사용자가 직접 전달 처리. 확정 시각: 2026-05-29 (R0) |

## Goal
인터넷이 연결된 머신에서 실행되는 **빌드/업데이트 CLI 도구**를 만든다. 이 도구는 opencode(sst/opencode) 코어와 oh-my-opencode 플러그인, 그리고 폐쇄망에서 동작 가능한 **모든 로컬 런타임 의존성**(로컬 MCP 서버, 광범위한 언어별 LSP 서버, ast-grep 등)을 가져와 **하나의 Windows x64 단일 실행 파일(.exe)**로 패키징한다. 사용자는 이 단일 exe를 폐쇄망으로 직접 옮겨 실행하며, exe는 vLLM의 OpenAI 호환 API에 config 파일로 연결되어 oh-my-opencode의 전체 로컬 기능(에이전트/서브에이전트, LSP/AST, 로컬 MCP)을 오프라인에서 제공한다. 업데이트는 동일한 도구로 항상 최신 버전을 가져와 새 단일 exe를 다시 생성하는 방식이다.

## Constraints
- **산출물은 반드시 단일 `.exe` 파일 하나** (data 폴더 동반 불가 — Contrarian 도전 기각, R4). 다중 서브프로세스 바이너리(MCP/LSP)는 exe 내부에 임베드하고 런타임에 자체 추출.
- **빌드/업데이트는 인터넷 연결 머신에서만 수행** (opencode/플러그인 다운로드 필요). 폐쇄망 안에서는 빌드하지 않음.
- **대상 플랫폼: Windows x64** (가정 — 사용자 미정정 시 유효). 빌드 호스트 OS는 무관(bun `--compile`의 Windows 타깃 크로스 컴파일 활용).
- **vLLM 연결은 config 파일로 설정** (OpenAI 호환 엔드포인트 URL, 모델명, API 키 등).
- **로컬에서 동작하는 MCP만 번들**. 인터넷 의존 MCP(웹검색, 외부 호스팅 API)는 제외/비활성화 (R3).
- **LSP 커버리지는 광범위하게**: Java와 Vue를 최우선으로 포함, 가능한 한 거의 모든 언어 LSP 패키지 포함. **exe 용량 제한 없음** (R5).
- **업데이트 버전 정책: 항상 최신(latest)** — 명령 실행 시 opencode/oh-my-opencode 최신 버전을 가져와 빌드 (R6).
- 폐쇄망 런타임에는 별도 런타임(node/bun) 설치를 전제하지 않음 — exe가 완전 자족적이어야 함.

## Non-Goals
- 폐쇄망으로의 파일 전달 메커니즘 구현 (사용자가 직접 처리).
- 인터넷 의존 MCP의 폐쇄망 동작 (물리적으로 불가).
- 폐쇄망 내부에서의 오프라인 빌드/업데이트 (빌드는 인터넷 머신 전용).
- Windows 외 타깃(macOS/Linux) 산출물 (현 범위 외, 추후 확장 가능).
- Context7 완전 오프라인 미러링 (best-effort/선택적, 합격 기준 제외 — 아래 참조).

## Acceptance Criteria
- [ ] 인터넷 머신에서 단일 명령으로 빌드 시, 하나의 Windows x64 `.exe` 파일이 생성된다.
- [ ] 생성된 exe를 node/bun 미설치 Windows 환경에 복사 후 단독 실행하면 opencode TUI가 구동된다.
- [ ] exe가 config 파일의 vLLM OpenAI 호환 엔드포인트에 연결되어 채팅/코드 편집/서브에이전트가 동작한다.
- [ ] oh-my-opencode의 로컬 MCP 서버들이 오프라인에서 기동·응답한다 (인터넷 의존 MCP는 비활성 처리되어 오류 없이 우아하게 스킵).
- [ ] Java LSP와 Vue LSP가 오프라인에서 동작한다 (hover/정의이동/진단 중 최소 1개 확인). 추가로 광범위 언어 LSP가 번들에 포함된다.
- [ ] ast-grep 기반 코드 분석 툴이 오프라인에서 동작한다.
- [ ] 업데이트 명령을 인터넷 머신에서 실행하면 최신 opencode/oh-my-opencode를 가져와 새 단일 exe를 재생성한다 (기존 exe 교체용).
- [ ] config 파일만 바꿔 vLLM 엔드포인트/모델을 변경할 수 있다 (재빌드 불필요).

### 선택적(비합격-게이트) 기준
- [ ] (best-effort) Context7 라이브러리 문서를 빌드 시 캐싱해 폐쇄망에서 로컬 shim으로 서빙 — 동작하면 가치, 미동작 시 전체 합격에 영향 없음 (R7).

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 폐쇄망 안에서 빌드/업데이트가 일어난다 | "다운로드가 필요한데 폐쇄망에서 가능한가?" | 빌드/업데이트는 인터넷 머신에서, 산출물만 폐쇄망으로 전달 (R1) |
| "전체 기능"에 모든 MCP가 포함된다 | "인터넷 의존 MCP는 폐쇄망에서 물리적으로 불가" | 로컬 MCP만 번들, 인터넷 의존 MCP 제외 (R3) |
| 업데이트마다 재패키징이 필수다 | (Contrarian) "exe는 한 번만 굽고 자산팩만 교체하면?" | 기각 — 순수 단일 파일 유지가 더 중요 (R4) |
| 특정 언어 LSP만 필요하다 | "어떤 언어를 쓰는가?" | Java+Vue 우선 + 광범위 커버리지, 용량 무제한 (R5) |
| 버전을 핀 고정해야 한다 | (Simplifier) "가장 단순한 버전 정책은?" | 항상 최신 (R6) |
| Context7는 폐쇄망에서 불가하니 제외 | "캐싱해서라도 쓰고 싶다" | best-effort/선택적, 합격 게이트 제외 (R6→R7) |

## Technical Context
- **opencode (sst/opencode)**: Bun 기반 모노레포. `bun build --compile`로 Bun 런타임+코드를 단일 바이너리로 묶음. Go TUI는 `go build`로 별도 컴파일 후 함께 패키징. 즉 코어 자체가 이미 단일 바이너리 산출 메커니즘을 가짐.
- **oh-my-opencode (opensoft, → oh-my-openagent 전환 중)**: npm 패키지 + `opencode.json` 플러그인 엔트리로 로드. 큐레이팅된 에이전트/서브에이전트, 로컬 MCP, LSP/AST 툴, Claude Code 호환 레이어 포함. 런타임에 config 디렉토리에서 로드되므로 "임베드"는 플러그인 코드+의존 바이너리를 exe 내부 자산으로 넣고 첫 실행 시 추출하는 방식이 필요.
- **패키징 전략 후보**: bun `--compile`의 에셋 임베딩으로 MCP/LSP 바이너리를 exe에 포함 → 첫 실행 시 로컬 캐시 디렉토리로 추출 → opencode가 추출된 바이너리를 서브프로세스로 기동. opencode.json 플러그인/MCP 설정도 임베드 기본값으로 주입.
- **vLLM**: OpenAI 호환 엔드포인트. opencode의 커스텀 provider(openai-compatible baseURL) 설정으로 연결 — config 파일에서 baseURL/model/apiKey 지정.

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| opencode 코어 | core domain | 버전, bun 바이너리, go TUI | Single Executable에 임베드됨 |
| oh-my-opencode 플러그인 | core domain | 버전, agents, 호환레이어 | opencode에 의해 로드됨; MCP/LSP 사용 |
| Single Executable (.exe) | core domain | Windows x64, 자족적 | 모든 의존성을 임베드; 폐쇄망에서 실행 |
| Build/Update Command | core domain | latest 정책, 빌드 호스트 | Single Executable 생성/재생성 |
| Local MCP server | supporting | 로컬 동작, node/bun shim | exe에 임베드, 런타임 추출 |
| LSP server (언어별) | supporting | Java, Vue, 광범위 | exe에 임베드, 런타임 추출 |
| ast-grep tool | supporting | 코드 분석 바이너리 | exe에 임베드 |
| vLLM endpoint | external system | baseURL, model, apiKey | config 파일로 연결 |
| Config file | supporting | vLLM 설정 | exe 런타임이 읽음 |
| Context7 cache | supporting (optional) | 라이브러리 문서 캐시 | best-effort, 빌드 시 prefetch |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 8 | 8 | - | - | N/A |
| 2 | 9 | 1 | 0 | 8 | 89% |
| 3 | 9 | 0 | 0 | 9 | 100% |
| 4 | 9 | 0 | 0 | 9 | 100% |
| 5 | 9 | 0 | 0 | 9 | 100% |
| 6 | 10 | 1 | 0 | 9 | 90% |
| 7 | 10 | 0 | 0 | 10 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (7 rounds + Round 0)</summary>

### Round 0 — Topology
**Q:** 4개 최상위 구성요소(번들 파이프라인 / 업데이트 명령 / 폐쇄망 전달 / 런타임 구성)가 맞는가?
**A:** 폐쇄망 전달은 직접 처리. vLLM 연결은 config 파일로 설정 가능하게.
→ 전달 deferred, 런타임 구성=config 파일.

### Round 1 — Constraint (빌드 환경)
**Q:** 빌드/업데이트 명령은 어디서 실행되나?
**A:** 인터넷 되는 머신에서 빌드.
**Ambiguity:** ~50%

### Round 2 — Success Criteria (기능 범위)
**Q:** "성공적으로 동작"의 범위는?
**A:** 전체 기능(MCP 포함).
**Ambiguity:** ~36%

### Round 3 — Constraint (외부 MCP)
**Q:** 인터넷 의존 MCP는 어떻게 처리?
**A:** 로컬 MCP만 포함.
**Ambiguity:** ~29%

### Round 4 — Contrarian (업데이트 형태)
**Q:** 재패키징 vs 자산교체, 어느 쪽이 중요?
**A:** 순수 단일 파일 유지.
**Ambiguity:** ~22%

### Round 5 — Success Criteria (LSP 언어)
**Q:** 폐쇄망에서 주로 개발하는 언어는?
**A:** Java와 Vue, 가급적 거의 모든 언어 패키지 처리, 용량 커도 OK.
**Ambiguity:** ~16%

### Round 6 — Simplifier (버전 정책)
**Q:** 업데이트의 버전 정책은?
**A:** 항상 최신. + Context7도 캐싱해서라도 연결 희망.
**Ambiguity:** ~19%

### Round 7 — Constraint/Criteria (Context7 캐시)
**Q:** Context7 오프라인 캐시 범위는?
**A:** best-effort, 선택적.
**Ambiguity:** ~14% ✅
</details>
