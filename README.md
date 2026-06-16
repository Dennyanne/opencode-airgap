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
  opencode-airgap.exe  ──복사──▶  %LOCALAPPDATA%\opencode-airgap\<ver>-<build>\
  versions.lock                      jre/, node/, lsp/, mcp/, ...
```

---

## 전제 조건 (빌드 머신)

빌드는 **인터넷이 되는 머신**에서만 실행합니다. 폐쇄망 머신에서는 `exe`만 실행하면 됩니다.

| 도구 | 버전 | 용도 |
|------|------|------|
| [Bun](https://bun.sh) | ≥ 1.1.0 | 빌드 런타임, 크로스 컴파일 |
| Git | — | 저장소 클론 |
| [Go](https://go.dev) | (선택) | gopls(Go LSP)를 포함하려는 경우에만. 없으면 gopls는 자동 skip |

> `tar`는 디렉토리 자산 패킹(빌드)·아카이브 추출(런타임)에 쓰이며, Windows 10+/Linux/macOS에 기본 포함되어 별도 설치가 필요 없습니다. 빌드 머신의 GitHub API 레이트리밋을 피하려면 `GITHUB_TOKEN`(또는 `GH_TOKEN`) 환경변수를 설정하세요.

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

### 1. (선택) Phase 0 스파이크 검증

세 스파이크는 이미 모두 PASS했고 self-hosted Windows CI(`windows-spikes` 잡)에서 자동 검증됩니다.
환경을 직접 확인하고 싶을 때만 아래를 실행하세요.

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

**첫 실행** 시 `%LOCALAPPDATA%\opencode-airgap\<ver>-<build>\`에 JRE, Node, LSP 서버 등을 추출합니다(약 60초 이내).
두 번째 실행부터는 캐시가 유효하면 추출 없이 바로 시작합니다. 캐시 폴더 이름에는 **빌드 해시**가
붙어, 새 exe(설정/자산 변경)는 기존 캐시를 덮어쓰지 않고 새 폴더에 추출합니다. 이렇게 하면 이전
캐시가 실행 중인 프로세스에 잠겨 있어도 충돌 없이 동작하며, 옛 빌드 폴더는 추출 성공 후 자동
정리(GC)됩니다(잠겨 있으면 건너뜀).

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
       ├─ opencode 코어 (sst/opencode 릴리스 아카이브, 예: opencode-windows-x64.zip)
       ├─ oh-my-opencode 플러그인 (npm 패키지 트리, 로컬 경로로 로드)
       ├─ JRE 21 (Temurin, jdtls용)
       ├─ Node 런타임 (Volar/tsserver/MCP용, Spike3 결과상 제거 가능)
       ├─ Volar (@vue/language-server)
       ├─ tsserver (typescript-language-server + typescript)
       ├─ Pyright (pyright)
       ├─ ast-grep (@ast-grep/cli)
       ├─ filesystem MCP (@modelcontextprotocol/server-filesystem)
       └─ asset-manifest.json (추출 경로 + sha256 다이제스트)

  선택적(없으면 경고 후 skip — 빌드 비중단):
       ├─ jdtls (Java LSP) — eclipse.jdt.ls는 GitHub 릴리스를 제공하지 않아 현재 자동 skip
       └─ gopls (Go LSP) — 빌드 머신에 Go 툴체인이 있으면 `go install`로 빌드, 없으면 skip
```

> 디렉토리 형태 자산(플러그인, npm LSP/MCP)은 단일 파일로만 임베드 가능한 Bun 제약 때문에
> 빌드 시 `.tar.gz`로 묶여 임베드되고, 런타임에 `tar`로 풀립니다.
> TUI는 최신 opencode가 본체에 번들하므로 별도 자산이 없습니다(자동 skip).

### 런타임 부트스트랩 흐름 (`src/embed/bootstrap.ts`)

```
exe 실행
  │
  ├─ 캐시 경로 결정: %LOCALAPPDATA% → %TEMP% → exe 옆 .cache (MAX_PATH 고려)
  │     캐시 폴더명 = <opencode 버전>-<빌드 해시>  (빌드별 격리 → 잠긴 옛 캐시 덮어쓰기 회피)
  │
  ├─ .complete 센티넬 + sha256 체크섬으로 유효 캐시 확인
  │     └─ 유효 → 추출 스킵, 즉시 시작
  │
  ├─ 추출 필요 시:
  │     ├─ CREATE_NEW 락 파일 (동시 실행 직렬화 / 스테일 락 자동 회수)
  │     ├─ 임시 디렉토리에 추출(아카이브는 tar로 unpack + 단일 최상위 폴더 평탄화)
  │     ├─ sha256 검증 → 기존 캐시는 옆으로 move-aside 후 원자적 rename(EPERM/EACCES 백오프 재시도) → .complete 기록
  │     ├─ 옛 빌드 캐시 GC (best-effort, 잠긴 폴더는 건너뜀)
  │     └─ 락 해제
  │
  ├─ ~/.config/opencode 시딩 (없을 때만 복사 — 사용자 편집 보존)
  │     기본 opencode.json + 플러그인의 .opencode/command·skills
  │
  ├─ 환경 변수 주입 (opencode에 전달)
  │     JAVA_HOME, OPENCODE_AIRGAP_CACHE, OPENCODE_DISABLE_LSP_DOWNLOAD=true, PATH,
  │     OMO_DISABLE_POSTHOG=1 외 (oh-my-opencode 텔레메트리 차단 — 폐쇄망 행 방지)
  │
  └─ 추출된 opencode 바이너리 spawn (CLI 인자·stdio 전달, 종료 코드 전파)
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
| **Spike 1** `spikes/spike1-bun-embed-spawn/` | Bun이 Windows exe에 네이티브 바이너리를 임베드하고 스폰할 수 있는가 (oven-sh/bun#10344) | **Windows 필수** | ✅ PASS — #10344 재현되지 않음 |
| **Spike 2** `spikes/spike2-jre-extract/` | JRE 21 임베드/추출 동작 + 추출 시간 ≤ 60s budget | **Windows 필수** | ✅ PASS |
| **Spike 3** `spikes/spike3-node-lsp/` | Bun이 tsserver를 직접 호스팅 가능한가 (Node 임베드 제거 가능성) | macOS/Windows | ✅ PASS (`bun-host`) |

> **Spike 3:** Bun 1.3.x에서 tsserver LSP initialize 핸드셰이크 성공 → `DECISION: bun-host`.
> Node 임베드 제거로 ~50-80 MB 절감 가능(현재 기본 빌드에는 Node 런타임이 포함됨).
> 세 스파이크 모두 self-hosted Windows CI(`windows-spikes` 잡)에서 자동 검증됩니다.

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

> `VLLM_MODEL`에는 `vllm/` 접두사를 붙이지 마세요. 번들 설정이 이미 `"model": "vllm/{env:VLLM_MODEL}"`로 감쌉니다.

#### `.env` 파일로 설정하기

opencode는 Bun 위에서 동작하며, Bun은 **실행 작업 디렉터리(cwd)의 `.env`를 자동으로 로드**합니다.
저장소 루트의 **`.env.example`** 을 복사해 값을 채우세요.

```powershell
# 실행할 작업 폴더(프로젝트 루트)에서
Copy-Item .env.example .env
# .env 를 편집해 VLLM_BASE_URL / VLLM_API_KEY / VLLM_MODEL 입력
```

```dotenv
# .env 예시
VLLM_BASE_URL=http://192.168.1.100:8000/v1
VLLM_API_KEY=not-used
VLLM_MODEL=meta-llama/Llama-3.1-70B-Instruct
```

- ⚠️ `.env`는 **exe 옆이 아니라 실행 시점의 cwd 기준**으로 로드됩니다. opencode를 실행하는 그 폴더에 두세요.
  현재 opencode는 config 디렉터리/상위 폴더의 `.env`는 자동 로드하지 않습니다([opencode#10458](https://github.com/anomalyco/opencode/issues/10458)).
- cwd와 무관하게 어디서든 적용하려면 **Windows 사용자 환경변수**가 가장 확실합니다(새 터미널부터 적용):
  ```powershell
  setx VLLM_BASE_URL "http://192.168.1.100:8000/v1"
  setx VLLM_API_KEY  "not-used"
  setx VLLM_MODEL    "meta-llama/Llama-3.1-70B-Instruct"
  ```
- `.env`에는 비밀값이 들어갈 수 있어 `.gitignore` 처리되어 있습니다. 추적되는 건 `.env.example` 템플릿뿐입니다.

### 모델 컨텍스트/출력 토큰 한도

vLLM처럼 커스텀(OpenAI 호환) provider는 models.dev에 없어서 opencode가 토큰 한도를
자동으로 알 수 없습니다. 따라서 `provider.vllm.models.<모델ID>.limit`에 직접 명시합니다.

```json
"limit": {
  "context": 131072,
  "output": 32768
}
```

| 필드 | 의미 |
|------|------|
| `limit.context` | 최대 **입력** 토큰 = 모델 컨텍스트 윈도우. opencode의 잔여 컨텍스트 추적/압축 트리거에 사용 |
| `limit.output` | 응답당 모델이 **생성**할 수 있는 최대 토큰 수 |

- 기본값은 `context: 131072` / `output: 32768`(Llama 3.1 계열 기준)입니다.
- ⚠️ **vLLM 서버 기동 옵션에 맞추세요.** 특히 `--max-model-len`보다 큰 `context`를 주면
  서버가 긴 요청을 거부합니다.
- 이 값은 **숫자**라서 `{env:VAR}` 치환을 쓰지 않습니다(빈/문자열 env는 JSON을 깨뜨림).
  재빌드 없이 바꾸려면 `OPENCODE_CONFIG` 오버라이드 파일이나 시드된
  `~/.config/opencode/opencode.json`에서 직접 수정하세요.

### 부트스트랩이 자동으로 주입하는 변수 (수동 설정 불필요)

| 변수 | 값 |
|------|----|
| `OPENCODE_AIRGAP_CACHE` | 추출 캐시 루트 경로 — `opencode.json`의 `{env:OPENCODE_AIRGAP_CACHE}` 치환에 사용 |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | `true` — LSP 네트워크 자동 다운로드 차단 |
| `JAVA_HOME` | 추출된 JRE 21 경로 |
| `PATH` | Node/java/gopls/pyright 디렉토리가 앞에 추가됨 |
| `OMO_DISABLE_POSTHOG` 등 | oh-my-opencode의 PostHog 텔레메트리 opt-out — 폐쇄망에서 외부 전송 시도로 인한 기동 지연 방지 |

> **설정 시딩 모델:** 부트스트랩은 `OPENCODE_CONFIG`를 강제하지 않습니다. 대신 첫 실행 시 기본
> `opencode.json`(및 플러그인의 command/skills)을 `~/.config/opencode`에 **없을 때만** 복사하므로,
> opencode가 표준 위치에서 설정을 읽고 사용자가 그 디렉토리에서 편집한 내용이 유지됩니다.
> 사용자가 직접 `OPENCODE_CONFIG`를 지정하면 그 값이 우선합니다(아래 실행 "방법 B").

### LSP 지원 현황

| LSP | 키 | 확장자 | 수집 현황 |
|-----|----|--------|-----------|
| Volar (@vue/language-server) | `lsp.vue` | `.vue` | ✅ 포함 (npm) |
| typescript-language-server (+typescript) | `lsp.typescript` | `.ts .tsx .js .jsx` | ✅ 포함 (npm) |
| Pyright | `lsp.python` | `.py` | ✅ 포함 (npm) |
| jdtls (Eclipse JDT) | `lsp.java` | `.java` | ⚠️ 선택적 — eclipse.jdt.ls가 GitHub 릴리스를 제공하지 않아 현재 자동 skip |
| gopls | `lsp.go` | `.go` | ⚠️ 선택적 — 빌드 머신에 Go 툴체인이 있을 때만 `go install`로 포함 |

> ⚠️ 선택적 LSP는 수집 실패 시 경고만 남기고 건너뛰며 빌드를 중단하지 않습니다.
> 해당 언어 LSP가 빠진 채로도 나머지는 정상 동작합니다.
> Java LSP가 필요하면 jdtls 자산 소스를 직접 스테이징하거나, Go LSP가 필요하면 빌드 머신에 Go를 설치하세요.

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
| Phase 0 | 리스크 스파이크 하니스 | ✅ 완료 (세 스파이크 모두 Windows CI PASS) |
| Phase 1 | 빌드 도구 스캐폴딩 (`airbuild` CLI, 타입 계약, 부트스트랩) | ✅ 완료 |
| Phase 2 | 자산 수집 (opencode, oh-my-opencode, JRE, Node, LSP, MCP fetch) | ✅ 완료 (`src/fetcher/`) |
| Phase 3 | Config 합성 (opencode.json 경로 주입) | ✅ 완료 (`src/fetcher/config.ts`) |
| Phase 4 | 단일 exe 컴파일 (`bun build --compile`) | ✅ 완료 — Windows CI에서 실자산 빌드 검증 |
| Phase 5 | `airbuild update` + 롤백 | ✅ 완료 |
| Phase 6 | 검증 하니스 (AC1~AC13) | ✅ 완료 (`script/verify/`) |
| Phase 7 | 런타임 opencode 기동 (추출된 opencode 바이너리 spawn) | ✅ 완료 |

**현재 동작 (엔드투엔드):** 인터넷 머신에서 `airbuild build`/`update`가 모든 자산을 받아 단일 exe로
컴파일하고, 폐쇄망에서 exe 실행 시 부트스트랩이 자산을 캐시로 추출·검증하고 환경을 구성한 뒤
**추출된 opencode 바이너리를 그대로 spawn**합니다(CLI 인자·stdio 전달). 즉 `opencode-airgap.exe`는
폐쇄망용 opencode 그 자체로 동작합니다.

---

## 알려진 제약 및 주의사항

- **선택적 LSP 누락**: jdtls(Java)는 eclipse.jdt.ls가 GitHub 릴리스를 제공하지 않아 기본 빌드에서 빠집니다. gopls(Go)는 빌드 머신에 Go 툴체인이 있을 때만 포함됩니다. 둘 다 없어도 빌드는 성공하며 해당 언어 LSP만 비활성화됩니다.
- **exe 아이콘/메타데이터**: **Windows 호스트에서 빌드하면 아이콘 및 버전 정보(`VERSIONINFO`) 삽입이 가능합니다.** macOS/Linux에서 크로스 컴파일 시에는 Bun이 이를 지원하지 않으므로, 필요한 경우 빌드 후 `rcedit`으로 별도 처리하거나 Windows 빌드 호스트를 사용하세요.
- **AV/SmartScreen 차단 리스크**: 미서명 대용량 자기추출 exe는 기업 PC의 Windows Defender SmartScreen이나 엔드포인트 AV에 의해 차단될 수 있습니다. 코드 서명을 적용하거나 사내 AV 허용 목록에 등록하는 절차가 필요할 수 있습니다. (AV가 갓 추출된 바이너리를 잠그면 첫 실행 시 일시적 `EPERM`이 날 수 있어, 부트스트랩은 캐시 승격을 백오프 재시도합니다.)
- **Bun#10344**: Windows 컴파일 exe가 임베드 네이티브 바이너리를 스폰할 때의 크래시 이슈 — **Spike 1에서 재현되지 않음을 확인**했습니다(Windows CI에서 자동 검증).

---

## 문제 해결 (Troubleshooting)

### 새 exe로 다시 빌드 → 캐시 정리 → 실행

캐시 폴더는 `%LOCALAPPDATA%\opencode-airgap\<버전>-<빌드해시>` 형태이며, 빌드(설정/자산)가
바뀌면 **새 폴더에 추출**됩니다. 따라서 보통은 옛 캐시를 수동으로 지울 필요가 없습니다. 그래도
깨끗이 다시 시작하고 싶다면:

```powershell
# 1) 캐시를 점유 중인 프로세스 확인 (있으면 종료)
Get-Process node,opencode,opencode-airgap,java -ErrorAction SilentlyContinue | Select Id,ProcessName,Path
#    예: Stop-Process -Id <PID> -Force

# 2) 캐시 통째로 삭제 (선택)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\opencode-airgap"

# 3) (빌드 머신) 재빌드 — GITHUB_TOKEN으로 API 레이트리밋(403) 회피
$env:GITHUB_TOKEN = "ghp_..."
bun run src/cli/index.ts build --out dist\opencode-airgap.exe

# 4) 새 exe 실행
.\opencode-airgap.exe
```

### 첫 실행/추출 시 `EPERM` / `EACCES` (rename·rm 실패)

방금 추출된 바이너리를 백신/인덱서가 잠그거나, 옛 캐시를 실행 중인 인스턴스가 점유하면 발생할 수
있습니다. 부트스트랩이 자동으로 대응합니다:

- 디렉터리 평탄화·캐시 승격은 백오프 재시도하며, 마지막엔 복사 폴백/ move-aside로 처리합니다.
- 빌드별 캐시 격리로 **새 빌드는 잠긴 옛 캐시를 건드리지 않습니다**. 옛 빌드 폴더는 추출 성공 후
  best-effort로 정리되며, 잠겨 있으면 건너뜁니다.

그래도 막히면 실행 중인 `opencode`/`node`/`java`를 모두 종료(또는 재부팅)한 뒤 위 "캐시 정리"를
수행하세요. 에러 메시지에 점유 프로세스를 종료하라는 안내가 함께 출력됩니다.

### `opencode-airgap.exe`가 실행되자마자 즉시 종료됨

TUI는 종료 시 화면을 복원해 에러가 안 보일 수 있습니다. stderr를 파일로 떠서 확인하세요:

```powershell
& "$env:LOCALAPPDATA\opencode-airgap\<버전>-<빌드해시>\opencode\opencode.exe" 2> "$env:TEMP\oc-err.txt"
"exit=$LASTEXITCODE"; Get-Content "$env:TEMP\oc-err.txt"
# opencode 자체 로그:
Get-ChildItem "$env:USERPROFILE\.local\share\opencode\log\*.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Tail 60
```

`Configuration is invalid ...`가 보이면 `~/.config/opencode/opencode.json`이 잘못된 것입니다.
이 파일은 **유효한 JSON이면 자동 교체되지 않으므로**, 처음 잘못 시드된 경우 직접 수정해야 합니다
(예: `model`은 `"vllm/모델명"` **문자열**이어야 함). vLLM 연결 환경변수(`VLLM_BASE_URL` 등)도
설정돼 있어야 합니다 — 위 "Config 설정" 참고.

### 그냥 `opencode`라고 치면 `MODULE_NOT_FOUND`

`%AppData%\Roaming\npm`에 따로 설치된 글로벌 npm `opencode-ai`(셰임)가 PATH에서 가로채는
경우입니다. 에어갭 도구는 항상 **`opencode-airgap.exe`로 실행**하세요. 깨진 글로벌 셰임을 없애려면
`npm uninstall -g opencode-ai`.

### 빌드 시 GitHub API `HTTP 403`

비인증 요청은 시간당 60회로 제한됩니다. 빌드 전 `GITHUB_TOKEN`(또는 `GH_TOKEN`)을 설정하세요
(공개 저장소라 스코프 없는 토큰이면 충분). 페처가 이를 자동으로 사용합니다.

---

## 개발 참고

```powershell
# 타입 체크
bun run typecheck            # = tsc --noEmit

# CLI help 확인
bun run src/cli/index.ts --help

# 검증 하니스 (script/verify/ 의 개별 AC 스크립트)
bun run script/verify/ac1-build.ts
bun run script/verify/ac8-from-lock.ts

# JSON config 유효성 검사
bun -e "JSON.parse(await Bun.file('templates/opencode.json').text()); console.log('ok')"
```

### CI

`.github/workflows/spikes.yml`이 self-hosted Windows x64 러너에서 두 잡을 실행합니다.

| 잡 | 검증 |
|----|------|
| `windows-spikes` | 타입체크 + spike1/2/3 (`run.ps1`) |
| `windows-build` | `airbuild build` + `airbuild update` 엔드투엔드 (실자산 다운로드·컴파일·lock·교체) — `GITHUB_TOKEN`으로 레이트리밋 회피 |

---

## 라이선스 및 서드파티 고지

- 이 저장소의 **소스 코드**(airbuild 빌드/업데이트 도구 및 런타임 부트스트랩)는 **MIT License**입니다 — `LICENSE` 참고.
- 빌드 산출물 `opencode-airgap.exe`는 opencode, oh-my-opencode, Eclipse Temurin JRE, Node.js, 각종 LSP/MCP/도구를 **임베드·재배포**합니다. 이들은 MIT가 아니라 **각자의 라이선스**를 따릅니다. 구성요소별 라이선스와 재배포 의무는 **`THIRD-PARTY-NOTICES.md`** 에 정리돼 있습니다.
- 빌드 시 `THIRD-PARTY-NOTICES.md`가 `asset-manifest.json`과 함께 exe 옆에 자동 복사됩니다. **exe를 재배포할 때는 이 고지 파일을 반드시 동봉**하세요.
- 특히 **Temurin JRE는 GPLv2 + Classpath Exception**입니다. Classpath Exception 덕에 나머지 코드로 GPL이 전염되지 않지만, JRE 바이너리 재배포 시 **라이선스 고지 + 대응 소스 제공(또는 서면 오퍼)** 의무가 있습니다(소스: adoptium.net). 자세한 내용은 `THIRD-PARTY-NOTICES.md` 참고.
- `opencode-airgap`은 폐쇄망용 **비공식 재배포**이며 업스트림 프로젝트의 보증/제휴와 무관합니다.
