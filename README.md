# opencode-airgap

폐쇄망(인터넷 차단 환경)에서 vLLM(OpenAI 호환 API)을 백엔드로 opencode를 실행할 수 있도록,
opencode + oh-my-opencode + 모든 의존성(JRE, LSP 서버, MCP 서버, ast-grep)을
**하나의 Windows x64 `.exe`** 파일로 패키징하는 빌드/업데이트 도구.

```
인터넷 머신                          폐쇄망 머신
──────────────────────               ──────────────────────────────────────
  airbuild build                        opencode-airgap.exe 실행
       │                                   │ (첫 실행 시 자산 추출)
       ▼                                   ▼
  opencode-airgap.exe  ──복사──▶  %LOCALAPPDATA%\opencode-airgap\<ver>\
  versions.lock                      jre/, node/, lsp/, mcp/, ...
```

---

## 전제 조건 (빌드 머신)

빌드는 **인터넷이 되는 머신**에서만 실행합니다. 폐쇄망 머신에서는 `exe`만 실행하면 됩니다.

| 도구 | 버전 | 용도 |
|------|------|------|
| [Bun](https://bun.sh) | ≥ 1.1.0 | 빌드 런타임, 크로스 컴파일 |
| Git | — | 저장소 클론 |

**Windows (권장 빌드 호스트)**
```powershell
# Bun 설치 (터미널 재시작 필요)
winget install oven-sh.bun
# 또는: powershell -c "irm bun.sh/install.ps1 | iex"

# 저장소 세팅
git clone https://github.com/Dennyanne/opencode-airgap.git
cd opencode-airgap
bun install
```

**macOS / Linux (크로스 컴파일 가능, 단 exe 아이콘/메타데이터 삽입 불가)**
```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/Dennyanne/opencode-airgap.git
cd opencode-airgap
bun install
```

---

## 빠른 시작

### 1. Phase 0 스파이크 먼저 실행 (Windows 필수)

**풀 빌드(Phase 2+)는 아래 세 스파이크가 모두 통과한 뒤에만 진행합니다.**

```powershell
# Windows PowerShell — 세 스파이크를 순서대로 실행

# Spike 1: Bun Windows 임베드-스폰 검증 (oven-sh/bun#10344)
cd spikes\spike1-bun-embed-spawn
.\run.ps1

# Spike 2: JRE 추출 시간 budget 측정
cd ..\spike2-jre-extract
.\run.ps1

# Spike 3: Node-LSP Bun 호스팅 가능 여부 (macOS에서도 실행 가능)
cd ..\spike3-node-lsp
./run.sh   # macOS / Linux
.\run.ps1  # Windows
```

각 스파이크의 PASS/FAIL 기준은 해당 디렉토리의 `README.md`를 참고하세요.

### 2. 빌드

```powershell
# 기본: Windows x64 exe 생성 (현재 디렉토리에 opencode-airgap.exe)
bun run src/cli/index.ts build

# 출력 경로 지정
bun run src/cli/index.ts build --out dist\opencode-airgap.exe

# 이전 versions.lock으로 동일 버전 재현
bun run src/cli/index.ts build --from-lock versions.lock
```

### 3. 업데이트 (항상 최신 버전)

```powershell
bun run src/cli/index.ts update --out opencode-airgap.exe
```

`airbuild update`는 임시 파일로 빌드 → 성공 시에만 기존 exe 교체 → `versions.lock` 기록합니다.
빌드 실패 시 기존 exe는 그대로 보존됩니다(롤백).

---

## 폐쇄망 머신에서 실행

### 준비

1. `opencode-airgap.exe`를 폐쇄망 머신으로 복사합니다.
2. `templates/opencode-airgap.config.json`을 복사해 vLLM 정보를 입력합니다.

```json
{
  "provider": {
    "vllm": {
      "options": {
        "baseURL": "http://192.168.1.100:8000/v1",
        "apiKey": "not-used"
      },
      "models": {
        "meta-llama/Llama-3.1-70B-Instruct": {
          "name": "Llama 3.1 70B"
        }
      }
    }
  }
}
```

### 실행

```powershell
# 방법 A: 환경 변수로 vLLM 지정 (재빌드 불필요)
$env:VLLM_BASE_URL = "http://192.168.1.100:8000/v1"
$env:VLLM_API_KEY  = "not-used"
$env:VLLM_MODEL    = "meta-llama/Llama-3.1-70B-Instruct"
.\opencode-airgap.exe

# 방법 B: 오버라이드 config 파일 지정
$env:OPENCODE_CONFIG = "C:\path\to\opencode-airgap.config.json"
.\opencode-airgap.exe
```

**첫 실행** 시 `%LOCALAPPDATA%\opencode-airgap\<ver>\`에 JRE, Node, LSP 서버 등을 추출합니다(약 60초 이내).
두 번째 실행부터는 캐시가 유효하면 추출 없이 바로 시작합니다.

---

## `airbuild` 명령어 레퍼런스

```
airbuild build   [--target <triple>] [--out <file>] [--from-lock <path>]
airbuild update  [--target <triple>] [--out <file>]
```

| 플래그 | 기본값 | 설명 |
|--------|--------|------|
| `--target` | `bun-windows-x64` | 컴파일 타깃 (`bun-windows-x64` \| `bun-linux-x64` \| `bun-darwin-arm64`) |
| `--out` | `opencode-airgap.exe` | 출력 파일 경로 |
| `--from-lock` | — | `versions.lock`을 읽어 동일 버전으로 재현 빌드 (`build` 전용) |

---

## 아키텍처

### 단일 exe의 의미

"단일 파일 배포"는 **사용자가 옮기고 교체하는 단위가 exe 하나**임을 의미합니다.
exe 내부에는 모든 바이너리 자산이 임베드되어 있고, **첫 실행 시** 로컬 캐시로 추출됩니다.

```
opencode-airgap.exe  (단일 파일)
  └─ bun --compile 임베드
       ├─ opencode 코어 (Bun 런타임)
       ├─ opencode Go TUI 바이너리
       ├─ oh-my-opencode 플러그인 페이로드
       ├─ JRE 21 (Temurin, jdtls용)
       ├─ Node 런타임 (Volar/tsserver/MCP용, Spike3 결과에 따라 제거 가능)
       ├─ jdtls (Eclipse JDT Language Server)
       ├─ Volar (@vue/language-server)
       ├─ tsserver, pyright, gopls (best-effort)
       ├─ ast-grep (@ast-grep/cli)
       ├─ filesystem MCP (@modelcontextprotocol/server-filesystem)
       └─ asset-manifest.json (추출 경로 + sha256 다이제스트)
```

### 런타임 부트스트랩 흐름 (`src/embed/bootstrap.ts`)

```
exe 실행
  │
  ├─ 캐시 경로 결정: %LOCALAPPDATA% → %TEMP% → exe 옆 .cache (MAX_PATH 고려)
  │
  ├─ .complete 센티넬 + sha256 체크섬으로 유효 캐시 확인
  │     └─ 유효 → 추출 스킵, 즉시 시작
  │
  ├─ 추출 필요 시:
  │     ├─ CREATE_NEW 락 파일 (동시 실행 직렬화 / 스테일 락 자동 회수)
  │     ├─ 임시 디렉토리에 추출 → sha256 검증 → 원자적 rename → .complete 기록
  │     └─ 락 해제
  │
  └─ 환경 변수 주입 후 opencode 위임
       JAVA_HOME, OPENCODE_AIRGAP_CACHE, OPENCODE_DISABLE_LSP_DOWNLOAD=true, PATH
```

### 재현 가능한 빌드 (`versions.lock`)

`airbuild update`는 모든 자산의 버전 + sha256 다이제스트를 `versions.lock`에 기록합니다.
`airbuild build --from-lock versions.lock`을 실행하면 동일 구성의 exe를 재생성할 수 있습니다.
이 다이제스트는 런타임 부트스트랩의 무결성 검증에도 재사용됩니다(단일 메커니즘).

---

## Phase 0 스파이크 요약

Phase 2 이후의 자산 수집/컴파일은 아래 세 스파이크가 모두 통과해야 진행합니다.

| 스파이크 | 검증 내용 | 실행 환경 | 결과 |
|----------|-----------|-----------|------|
| **Spike 1** `spikes/spike1-bun-embed-spawn/` | Bun이 Windows exe에 네이티브 바이너리를 임베드하고 스폰할 수 있는가 (oven-sh/bun#10344) | **Windows 필수** | ⬜ 미확인 |
| **Spike 2** `spikes/spike2-jre-extract/` | JRE 21 임베드/추출 동작 + 추출 시간 ≤ 60s budget | **Windows 필수** | ⬜ 미확인 |
| **Spike 3** `spikes/spike3-node-lsp/` | Bun이 tsserver를 직접 호스팅 가능한가 (Node 임베드 제거 가능성) | macOS/Windows | ✅ macOS PASS (`bun-host`) |

> **Spike 3 macOS 결과:** Bun 1.3.14에서 tsserver LSP initialize 핸드셰이크 성공 → `DECISION: bun-host`.
> Node 임베드 제거로 ~50-80 MB 절감 가능. **Windows에서 최종 확인 필요.**

---

## 프로젝트 구조

```
opencode-airgap/
├── src/
│   ├── cli/
│   │   ├── index.ts          # airbuild CLI 진입점 (shebang, 인수 파싱)
│   │   ├── build.ts          # `airbuild build` — 자산 스테이징 → 컴파일 오케스트레이션
│   │   ├── update.ts         # `airbuild update` — 최신 버전 + 롤백-안전 교체
│   │   └── version.ts        # TOOL_VERSION 상수
│   └── embed/
│       ├── manifest.ts       # 공유 타입: AssetManifest, VersionsLock, 상수 (빌드/런타임 양쪽 import)
│       └── bootstrap.ts      # 런타임 추출 프로토콜 (exe 내 실행)
├── script/
│   └── build-exe.ts          # bun build --compile 실행, versions.lock 읽기/쓰기
├── templates/
│   ├── opencode.json         # 임베드 기본 config (vLLM provider, LSP, MCP 경로)
│   ├── opencode-airgap.config.json  # 사용자 오버라이드 샘플
│   └── README.md             # Config 상세 레퍼런스
├── spikes/
│   ├── spike1-bun-embed-spawn/  # Bun#10344 재현/반증 하니스
│   ├── spike2-jre-extract/      # JRE 임베드/추출 budget 측정
│   └── spike3-node-lsp/         # Bun vs Node LSP 호스팅 결정
├── staging/                  # 빌드 시 자산이 수집되는 디렉토리 (gitignored)
│   └── .gitkeep
├── .omc/
│   ├── specs/deep-interview-opencode-airgap-bundle.md  # 요구사항 스펙
│   └── plans/opencode-airgap-bundle-plan.md            # 구현 플랜 (합의 완료)
├── package.json
└── tsconfig.json
```

---

## Config 설정

자세한 내용은 **`templates/README.md`** 를 참고하세요. 핵심만 정리합니다.

### 필수 환경 변수 (폐쇄망 머신에서 설정)

| 변수 | 설명 |
|------|------|
| `VLLM_BASE_URL` | vLLM OpenAI 호환 API 엔드포인트 (예: `http://192.168.1.100:8000/v1`) |
| `VLLM_API_KEY` | API 키 (`not-used`도 대부분의 vLLM 배포에서 동작) |
| `VLLM_MODEL` | 모델 ID (vLLM 서버가 보고하는 모델 이름과 일치해야 함) |

### 부트스트랩이 자동으로 주입하는 변수 (수동 설정 불필요)

| 변수 | 값 |
|------|----|
| `OPENCODE_AIRGAP_CACHE` | 추출 캐시 루트 경로 — `opencode.json`의 `{env:OPENCODE_AIRGAP_CACHE}` 치환에 사용 |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | `true` — LSP 네트워크 자동 다운로드 차단 |
| `JAVA_HOME` | 추출된 JRE 21 경로 |
| `PATH` | Node/java/gopls/pyright 디렉토리가 앞에 추가됨 |

### LSP 지원 현황

| LSP | 키 | 확장자 | 합격 게이트 |
|-----|----|--------|------------|
| jdtls (Eclipse JDT) | `lsp.java` | `.java` | ✅ 필수 (AC4) |
| Volar (@vue/language-server) | `lsp.vue` | `.vue` | ✅ 필수 (AC5) |
| typescript-language-server | `lsp.typescript` | `.ts .tsx .js .jsx` | best-effort |
| Pyright | `lsp.python` | `.py` | best-effort |
| gopls | `lsp.go` | `.go` | best-effort |

### MCP 비활성화 (폐쇄망 불가)

oh-my-opencode 내장 MCP 중 외부 인터넷이 필요한 3종은 `enabled: false`로 비활성화됩니다.
오류 없이 스킵되며 전체 기동에 영향을 주지 않습니다.

| MCP 키 | 서비스 | 사유 |
|--------|--------|------|
| `mcp.websearch` | Exa 웹 검색 | 인터넷 필요 |
| `mcp.context7` | Context7 라이브러리 문서 | 인터넷 필요 |
| `mcp.grep_app` | grep.app 코드 검색 | 인터넷 필요 |

---

## 현재 구현 상태

| Phase | 내용 | 상태 |
|-------|------|------|
| Phase 0 | 리스크 스파이크 하니스 | ✅ 스크립트 작성 완료 / ⬜ Windows 실행 대기 |
| Phase 1 | 빌드 도구 스캐폴딩 (`airbuild` CLI, 타입 계약, 부트스트랩) | ✅ 완료 |
| Phase 2 | 자산 수집 (opencode, oh-my-opencode, JRE, Node, LSP, MCP fetch) | ✅ 완료 (`src/fetcher/`) |
| Phase 3 | Config 합성 (opencode.json 경로 주입) | ✅ 완료 (`src/fetcher/config.ts`) |
| Phase 4 | 단일 exe 컴파일 (`bun build --compile`) | ✅ 구조 완료 / ⬜ 실자산 필요 |
| Phase 5 | `airbuild update` + 롤백 | ✅ 완료 |
| Phase 6 | 검증 하니스 (AC1~AC13) | ✅ 완료 (`script/verify/`) |

**다음 단계:** Windows 머신에서 Spike 1·2 실행 → 통과 시 Phase 2 자산 수집 구현.

---

## 알려진 제약 및 주의사항

- **exe 아이콘/메타데이터**: **Windows 호스트에서 빌드하면 아이콘 및 버전 정보(`VERSIONINFO`) 삽입이 가능합니다.** macOS/Linux에서 크로스 컴파일 시에는 Bun이 이를 지원하지 않으므로, 필요한 경우 빌드 후 `rcedit`으로 별도 처리하거나 Windows 빌드 호스트를 사용하세요.
- **AV/SmartScreen 차단 리스크**: 미서명 대용량 자기추출 exe는 기업 PC의 Windows Defender SmartScreen이나 엔드포인트 AV에 의해 차단될 수 있습니다. 코드 서명을 적용하거나 사내 AV 허용 목록에 등록하는 절차가 필요할 수 있습니다.
- **Bun#10344**: Windows에서 컴파일된 exe가 임베드된 네이티브 바이너리를 스폰할 때 크래시가 보고된 이슈입니다. Spike 1이 이 리스크를 검증합니다. 재현될 경우 단일 exe 접근 자체를 재검토해야 합니다.

---

## 개발 참고

```powershell
# 타입 체크
bunx tsc --noEmit

# CLI help 확인
bun run src/cli/index.ts --help

# 검증 하니스 실행 (AC1/AC8/AC9/AC13 자동화)
bun run script/verify/run-all.ts

# JSON config 유효성 검사
bun -e "JSON.parse(await Bun.file('templates/opencode.json').text()); console.log('ok')"
```
