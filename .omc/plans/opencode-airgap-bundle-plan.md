# Work Plan: 폐쇄망용 opencode + oh-my-opencode 단일 exe 빌드/업데이트 도구

> Status: **pending approval** (consensus refined — Architect+Critic 반영, iteration 2)
> Source spec: `.omc/specs/deep-interview-opencode-airgap-bundle.md`
> Mode: consensus --direct (non-interactive), RALPLAN-DR short

## Requirements Summary
인터넷 연결 머신에서 실행하는 빌드/업데이트 CLI 도구를 만든다. 이 도구는 opencode(sst/opencode) 코어 + Go TUI + oh-my-opencode 플러그인 + 폐쇄망에서 동작하는 모든 로컬 런타임 의존성(로컬 MCP, 광범위 LSP, ast-grep, Java LSP용 JRE)을 **하나의 Windows x64 `.exe`**로 임베드한다. 사용자는 그 단일 exe를 폐쇄망으로 직접 옮겨 실행하고, exe는 임베드된 자산을 첫 실행 시 로컬 캐시로 추출한 뒤 vLLM(OpenAI 호환 API)에 config 파일로 연결되어 전체 로컬 기능을 오프라인 제공한다. 업데이트는 동일 도구로 항상 최신 버전을 가져와 새 단일 exe를 재생성한다.

## 핵심 아키텍처 결정 (조기 확정 필요)
- **"단일 파일" = 배포물(distributable)이 exe 하나.** 런타임에는 exe가 임베드 자산(JRE, LSP/MCP/ast-grep 바이너리)을 로컬 캐시 디렉토리(`%LOCALAPPDATA%\opencode-airgap\<version>\`)로 **첫 실행 시 추출**한다. 사용자가 옮기고 교체하는 단위는 여전히 exe 하나이므로 R4 "순수 단일 파일" 제약을 충족. (용량 무제한 허용 — R5)
- **Java LSP(jdtls)는 JVM 필요** → 휴대용 JRE 21+를 exe에 임베드하고 첫 실행 시 추출, `lsp.java.command` / `JAVA_HOME`을 추출 경로로 지정.
- **폐쇄망 auto-install 차단** → `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, 모든 LSP/MCP/ast-grep 바이너리를 사전 임베드. npx 네트워크 fetch 금지.
- **원격 전용 MCP 비활성화** → oh-my-opencode 내장 `websearch`(Exa), `context7`, `grep_app`은 폐쇄망 불가 → config에서 disabled. (Context7은 R7에서 best-effort/선택적으로 descoped, 합격 게이트 아님.)
- **임베드 기본 config 주입** → opencode가 `$OPENCODE_CONFIG_CONTENT`(인라인) 또는 추출된 `~/.config/opencode/opencode.json`로 vLLM provider + 비활성 MCP + LSP 경로를 읽도록 구성. vLLM 값은 `{env:VAR}` 치환으로 사용자 config 파일에서 오버라이드 가능.
- **Node 런타임 결정 (확정, either/or 아님)**: 대부분의 LSP(tsserver, pyright, Volar)와 다수 로컬 MCP는 Node 패키지다. 폐쇄망에는 Node가 없으므로 **휴대용 Node 런타임을 exe에 임베드+추출하는 것을 기본(default) 결정**으로 한다. Phase 0 Spike #3가 "Bun이 해당 Node LSP/MCP를 직접 호스팅 가능"을 입증하면 그때 Node 임베드를 제거해 용량을 절감한다. 즉 안전한 기본값=Node 임베드, 최적화 조건부=Bun 호스팅. (스펙 line 42의 "별도 런타임 미전제"는 *사용자가 설치할 필요 없음*을 의미하며, exe가 자체 추출하는 런타임은 이를 위반하지 않음.)
- **재현성**: always-latest(R6)가 기본이되, 빌드 시 **전체 transitive 자산 버전+다이제스트**를 `versions.lock`에 기록하고 `airbuild build --from-lock <file>`로 동일 산출물을 재빌드할 수 있게 한다. 이 다이제스트 매니페스트는 런타임 부트스트랩의 무결성 검증에도 재사용한다(단일 메커니즘).

## RALPLAN-DR Summary (short)

### Principles (5)
1. 배포 단위는 단일 exe — 사용자가 옮기고 교체하는 것은 항상 파일 하나.
2. 폐쇄망에서 네트워크 fetch 0회 — 모든 의존성은 빌드 시점에 임베드.
3. 빌드/업데이트는 재현 가능한 단일 명령 — 부수 수작업 최소화.
4. 물리적으로 불가능한 것(원격 MCP)은 솔직히 descope, 우아하게 비활성.
5. Windows x64 타깃 우선, 빌드 호스트 OS는 비종속(크로스 컴파일).

### Decision Drivers (top 3)
1. **폐쇄망 오프라인 동작 보장** — auto-install/네트워크 의존 전부 제거가 최우선.
2. **단일 파일 배포 + 간단한 업데이트** — UX 핵심 통증 해소.
3. **전체 로컬 기능 패리티** — Java/Vue LSP + 로컬 MCP + ast-grep 실제 동작.

### Viable Options
**Option A — Bun `--compile` 에셋 임베딩 (단일 exe, 런타임 추출)** ✅ 채택
- Pros: R4 단일 파일 제약 충족; opencode 공식 빌드 경로 재사용; 업데이트=재컴파일로 단순.
- Cons: Bun Windows 임베드 바이너리 크래시 리스크(#10344); JRE 등 대용량 임베드로 exe가 큼; 첫 실행 추출 지연.

**Option B — exe + 사이드카 data 폴더** ❌ 기각
- 무효화 근거: R4에서 사용자가 "순수 단일 파일"을 명시적으로 선택하며 자산교체 방식을 기각함. 기술적으로 더 쉬우나 요건 위반.

**Option C — 포터블 디렉토리(zip) 배포** ❌ 기각
- 무효화 근거: 단일 파일 아님. R4 위반. 업데이트가 폴더 동기화로 회귀하여 사용자의 원래 통증(Docker 재세팅) 재현.

## Acceptance Criteria (testable)
- [ ] AC1: 인터넷 머신에서 `airbuild build` 단일 명령 실행 → 하나의 `opencode-airgap.exe`(Windows x64) 산출. 종료코드 0, 다른 산출물 파일 없음.
- [ ] AC2: node/bun/JVM 미설치 Windows 11 x64에 exe만 복사 후 실행 → opencode TUI 기동, 첫 실행 시 `%LOCALAPPDATA%\opencode-airgap\<ver>\`에 자산 추출 로그 확인.
- [ ] AC3: 네트워크 차단 상태(방화벽 all-deny)에서 exe 실행 → config의 vLLM baseURL로 채팅 1회 왕복 성공, 네트워크 요청은 vLLM 엔드포인트로만 발생(외부 0건, tcpdump/이벤트로그 확인).
- [ ] AC4: Java(.java) 파일 열기 → jdtls가 추출된 JRE로 기동, hover 또는 진단 1건 표시(`OPENCODE_DISABLE_LSP_DOWNLOAD=true` 하에서 다운로드 0).
- [ ] AC5: Vue(.vue) 파일 열기 → Volar LSP 기동, hover 또는 진단 1건 표시.
- [ ] AC6: ast-grep 기반 툴 호출 → 오프라인에서 패턴 검색 결과 반환.
- [ ] AC7: 로컬 MCP(예: filesystem/playwright 등 비원격) 최소 1종 기동·응답. 원격 MCP(websearch/context7/grep_app)는 disabled로 로드되어 오류·행 없이 스킵(로그에 "disabled (air-gapped)").
- [ ] AC8: `airbuild update` 실행 → 최신 opencode/oh-my-opencode/의존성 fetch 후 새 exe 재생성. **전체 transitive `versions.lock`(각 자산 버전+다이제스트)이 기록**되고, `airbuild build --from-lock versions.lock` 실행 시 동일 버전 구성의 exe가 재현됨(버전 동일성 검증).
- [ ] AC9: config 파일의 vLLM `baseURL`/`model`/`apiKey`만 변경 후 exe 재실행 → 재빌드 없이 새 엔드포인트로 연결.
- [ ] AC11: exe 인스턴스 2개를 동시 최초 실행 → 정확히 하나만 추출하고 다른 하나는 락 대기, 둘 다 정상 TUI 도달(추출 중복/경합 없음).
- [ ] AC12: 버전 캐시의 파일 1개를 삭제/손상시킨 뒤 exe 실행 → `.complete` 센티넬/체크섬으로 불완전 감지하여 재추출, 무성(silent) 파손 없음.
- [ ] AC13: `airbuild update`가 빌드 검증(AC1) 실패 시 → 직전 정상 exe가 보존되고 손상된 부분 산출물이 채택되지 않음(롤백 가능).
- [ ] AC10 (선택, 비게이트): Context7 best-effort — 빌드 시 지정 라이브러리 문서 prefetch 캐시가 있으면 로컬 shim으로 응답; 없으면 disabled. 미동작이 전체 합격에 영향 없음.
- 참고: **Java/Vue LSP만 합격 게이트(AC4/AC5)**. 그 외 "광범위 언어 LSP"는 Context7과 동일하게 **best-effort(비게이트)** 로 명시 — 포함되면 가치, 특정 언어 미동작은 전체 합격에 영향 없음.

## Implementation Steps

### Phase 0 — 리스크 스파이크 (선결, 차단 리스크 검증)
1. **Bun Windows 임베드-스폰 스파이크**: 작은 PoC로 `bun build --compile --target=bun-windows-x64`에 더미 네이티브 바이너리(예: ast-grep 또는 작은 exe)를 `import x from "./bin.exe" with { type: "file" }`로 임베드 → Windows에서 추출·spawn 검증. #10344 재현 여부 확인. **실패 시 Option A 재검토(사이드카로 폴백할지 사용자 재확인 필요).**
2. **JRE 임베드/추출 스파이크**: 휴대용 JRE 21(예: Temurin JRE) 압축본을 임베드 → 추출 → `java -version` 동작 확인. **통과 기준(budget): exe 추가 용량 및 첫 실행 추출 시간 측정 후 상한 합의(예: 첫 실행 추출 ≤ 60s)** — 측정만 하고 끝내지 않음.
3. **Node-LSP/MCP 런타임 스파이크 (#10344만큼 차단적)**: 대표 Node LSP(tsserver)와 Node MCP 1종을 오프라인에서 기동 시도. **(a)** Bun이 직접 호스팅 가능하면 Node 임베드 제거; **(b)** 불가하면 휴대용 Node 런타임 임베드를 확정. 결과로 "Node 런타임 결정"을 확정한다. **Phase 2+는 Spike #1·#2·#3 모두 통과 후에만 진행.**

### Phase 1 — 빌드 도구 스캐폴딩
3. 새 리포 구조 생성: `src/cli/` (airbuild CLI), `src/embed/` (자산 매니페스트), `staging/` (fetch된 자산), `templates/opencode.json` (임베드 기본 config), `script/build-exe.ts`.
4. `airbuild` CLI 골격(Bun): 서브커맨드 `build`, `update`, `--target=windows-x64`(기본), `--out`.

### Phase 2 — 자산 수집 (fetch, 인터넷 머신)
5. opencode 소스/릴리스 fetch + Go TUI 빌드(또는 공식 prebuilt Windows TUI 바이너리 사용) — `packages/opencode/script/build.ts` 흐름 참고, `--define OPENCODE_TUI_PATH` 연계.
6. oh-my-opencode(`oh-my-openagent`) npm 패키지 + 의존 자산 fetch. `bunx oh-my-opencode install` 산출물을 staging으로 수집. **검증: 설치 산출물이 *런타임에* npx/네트워크 fetch를 수행하지 않음을 확인**(런타임 npx 의존 발견 시 해당 자산을 사전 임베드 형태로 전환). 이게 폐쇄망 thesis의 전제.
7. LSP 바이너리 사전 스테이징: jdtls(eclipse.jdt.ls), Volar(`@vue/language-server`), 광범위 언어 LSP 세트(tsserver, pyright, gopls 등), ast-grep(`@ast-grep/cli` 네이티브). 휴대용 JRE 21 포함.
8. 로컬 MCP 서버(node 기반, npx 비의존 형태로 자산화) 스테이징. 원격 MCP는 수집 제외.

### Phase 3 — config 합성
9. `templates/opencode.json` 생성: 
   - `provider.vllm = { npm: "@ai-sdk/openai-compatible", options: { baseURL: "{env:VLLM_BASE_URL}", apiKey: "{env:VLLM_API_KEY}" }, models: { "{env:VLLM_MODEL}": {...} } }`
   - `lsp.java.command` → 추출 경로의 jdtls + `JAVA_HOME`=추출 JRE; `lsp.vue` → Volar; 기타 LSP 경로.
   - 원격 MCP(`websearch`,`context7`,`grep_app`) `enabled:false`.
   - 환경: `OPENCODE_DISABLE_LSP_DOWNLOAD=true`.
10. 사용자 오버라이드용 외부 config 샘플(`opencode-airgap.config.json`) + 로딩 규약 문서화(`$OPENCODE_CONFIG` 또는 exe 옆 파일 → `{env:VAR}` 주입).

### Phase 4 — 단일 exe 컴파일
11. 부트스트랩 엔트리(`src/embed/bootstrap.ts`) — **명시적 추출 프로토콜**:
    a. **대상 경로 선택**: 기본 `%LOCALAPPDATA%\opencode-airgap\<version>\`. 쓰기 불가/리다이렉트/읽기전용 프로파일 대비 **폴백 경로**(예: `%TEMP%`, exe 옆 `.\.cache\`) 순차 시도. Windows **롱패스(MAX_PATH 260)** 회피: 짧은 루트 + 매니페스트로 manifest 옵트인 또는 경로 길이 최소화.
    b. **동시성 락**: 추출 시작 전 `CREATE_NEW`로 배타적 락 파일 생성. 패자는 타임아웃 대기. **스테일 락 감지**(락 파일에 PID+timestamp 기록; 프로세스 부재 또는 임계 경과 시 회수)로 추출 중 크래시 데드락 방지(Windows 강제 락 특성 고려).
    c. **무결성/부분추출 복구**: 임시 디렉토리에 추출 → 각 파일 체크섬을 `versions.lock` 다이제스트와 대조 → 성공 시 원자적 rename → **마지막에 `.complete` 센티넬 기록**. 디렉토리 존재만으로 신뢰하지 않음. 시작 시 `.complete` 없거나 체크섬 불일치면 재추출.
    d. 환경변수 설정(`JAVA_HOME`, `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, LSP/Node 경로), opencode 메인 위임. 유효 캐시 존재 시 추출 스킵.
12. `script/build-exe.ts`: 모든 자산을 `with { type: "file" }`로 임베드하고 `bun build --compile --target=bun-windows-x64 --outfile opencode-airgap.exe`. (아이콘/버전 메타데이터는 Windows 호스트에서만 — cross-compile 한계 명시.)

### Phase 5 — 업데이트 명령
13. `airbuild update`: Phase 2~4 재실행으로 최신 버전 fetch→임베드→재컴파일. **전체 transitive `versions.lock`(자산별 버전+다이제스트) 기록**(항상 최신, R6). `airbuild build --from-lock versions.lock`는 lock을 *읽어* 동일 구성 재현(write-only 금지). **롤백**: 새 exe는 임시 파일로 빌드→AC1 빌드 검증 통과 시에만 최종 파일로 교체, 실패 시 직전 exe 보존. 산출 exe 파일명에 버전/날짜 태깅 옵션.

### Phase 6 — 검증 하니스
14. AC1~AC9 검증 스크립트(가능한 부분 자동화) + 폐쇄망 모사(방화벽 all-deny) 수동 체크리스트. AC10은 선택 검증.

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|-----------|
| Bun Windows 임베드 바이너리 크래시(#10344) | 단일 exe 접근 자체 붕괴 | Phase 0 스파이크로 조기 검증; 실패 시 사용자에게 사이드카 폴백 재확인 |
| Java LSP JVM 임베드로 exe 거대화/추출 지연 | UX 저하 | 용량 무제한 허용(R5); 추출 1회 캐시; 추출 진행 표시 |
| 원격 MCP 비활성화로 "전체 기능" 기대 미스매치 | 요건 인식 차이 | 스펙 R3/R7에서 합의됨; 로그로 명시적 비활성 표기 |
| 광범위 LSP 세트의 일부가 런타임 의존(node/JVM) | 일부 언어 LSP 미동작 | Java=임베드 JRE, node 기반=Bun/임베드 node로 기동; 미지원 언어는 best-effort 명시 |
| opencode/oh-my-opencode 상위 버전 호환 깨짐(항상 최신) | 업데이트 후 빌드 실패 | update 시 빌드 검증(AC1) 게이트; 실패 시 직전 exe 보존 |
| 크로스 컴파일 시 Windows 메타데이터 누락 | 아이콘/서명 부재 | 선택적 Windows 호스트 빌드 경로 문서화 |
| **AV/SmartScreen가 미서명 ~수백MB 자체추출 exe를 차단** | 폐쇄망 기업 PC에서 실행 자체 불가(AC2 차단) | 코드서명(가능 시) 또는 사내 AV 허용목록/SmartScreen 우회 절차 문서화; 추적 리스크로 격상(단순 follow-up 아님) |
| **Node 기반 LSP/MCP 런타임 미확정** | 다수 언어 LSP·MCP 미동작(핵심 드라이버 붕괴) | Phase 0 Spike #3로 Bun 호스팅 가부 검증; 기본은 휴대용 Node 임베드 |
| %LOCALAPPDATA% 쓰기불가/MAX_PATH 초과 | 추출 실패로 기동 불가 | Step 11a 폴백 경로 + 롱패스 처리 |
| 동시 최초 실행 경합 / 부분추출 무성 파손 | 깨진 캐시를 영구 신뢰 | Step 11b/c 락+센티넬+체크섬(AC11/AC12로 검증) |

## Verification Steps
1. Phase 0 스파이크 **3건 통과(임베드-스폰, JRE+budget, Node-LSP 런타임)** 후에만 Phase 1+ 진행.
2. 빌드 머신에서 AC1, AC8(`--from-lock` 재현 포함), AC9, AC13(롤백) 자동 검증.
3. 격리 Windows VM(네트워크 all-deny)에서 AC2~AC7 수동/반자동 검증. AC3의 tcpdump/이벤트로그로 `OPENCODE_DISABLE_LSP_DOWNLOAD=true`가 LSP 다운로드 시도 0임을 함께 확인.
4. 동일 격리 VM에서 AC11(동시 최초 실행), AC12(손상 캐시 복구) 검증.
5. AC10 및 Java/Vue 외 광범위 LSP는 선택(best-effort) — 미충족이어도 합격.

## ADR
- **Decision**: Bun `--compile` 에셋 임베딩으로 모든 의존성(JRE 포함)을 단일 Windows exe에 넣고 첫 실행 시 로컬 캐시로 추출. 빌드/업데이트는 인터넷 머신의 `airbuild` CLI가 수행.
- **Drivers**: 폐쇄망 오프라인 보장 / 단일 파일 배포 / 전체 로컬 기능 패리티.
- **Alternatives considered**: (B) exe+data 폴더 — R4 위반으로 기각; (C) 포터블 zip — 단일 파일 아님, 업데이트 통증 재현으로 기각.
- **Why chosen**: 유일하게 "단일 파일 배포 + 오프라인 전체 기능"을 동시에 만족. opencode 공식 빌드 경로 재사용으로 유지보수성 확보.
- **Consequences**: exe 용량 큼(JRE/LSP 임베드), 첫 실행 추출 지연; Bun Windows 임베드 리스크에 노출 → Phase 0 스파이크로 선검증 필수.
- **Follow-ups**: Context7 오프라인 shim(선택); Node 임베드 제거 최적화(Spike #3가 Bun 호스팅 입증 시); macOS/Linux 타깃 확장.

## Consensus Changelog
- **Iter 1 → Iter 2 (Architect + Critic 반영, Critic REJECT의 7개 필수 변경 적용)**:
  1. Node 런타임 결정 확정(기본=휴대용 Node 임베드, Spike #3로 Bun 호스팅 시 제거) — either/or 제거.
  2. Phase 0 **Spike #3(Node-LSP/MCP 런타임)** 추가, Phase 2+ 게이트.
  3. `airbuild build --from-lock` + 전체 transitive `versions.lock`(버전+다이제스트) 추가, AC8가 재현 검증.
  4. Step 11 부트스트랩을 명시 프로토콜로 확장(락+스테일감지, `.complete`+체크섬+원자적 rename, `%LOCALAPPDATA%` 폴백, MAX_PATH).
  5. **AV/SmartScreen** 리스크 행 추가(추적 리스크로 격상).
  6. **AC11(동시 최초 실행)·AC12(손상 캐시 복구)·AC13(update 롤백)** 추가.
  7. Java/Vue 외 "광범위 LSP"를 best-effort(비게이트)로 명시 descope.
  8. (부가) JRE 스파이크에 추출 시간 budget 추가; Step 6에 런타임 npx 비의존 검증 추가.
- **미해소(의도적)**: Architect의 "단일 파일이 하드 계약인가 vs 이동/업데이트 편의의 대리인가" 재확인 — 스펙 R4에서 사용자가 명시적으로 단일 파일을 선택했으므로 계획 범위 내 재논의 안 함. 실행 전 사용자가 뒤집고 싶으면 Option B(서명 exe + 서명 assets.pak)로의 피벗이 `versions.lock`+다이제스트 덕에 저비용임을 ADR Consequences에 기록.
