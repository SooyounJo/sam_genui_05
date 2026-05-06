# GenUI 저장·통신 데이터 스키마 (v1)

같은 “컴포넌트”를 가리키는 이름이 레이어마다 달라 저장·재로드 시 `slot` / `componentId` / `content` 매칭이 끊기는 것을 막기 위한 **단일 규약**입니다. 내부 파이프라인은 이미 [schema_normalizer.js](../schema_normalizer.js)로 **camelCase** 정규화를 합니다. 외부에 내보내거나 다시 읽을 때는 아래 필드 이름을 유지하는 것이 안전합니다.

## 한 줄 정의

- **`paletteId`**: [component_registry.json](../figma-refs/component_registry.json)의 컴포넌트 `id`와 동일. 플래너의 `componentType`, 레이아웃의 `layoutPlan.groups[].children[].componentId`와 **동치**.
- **`role` (DesignDoc / 렌더)**: **원자(atomic) 역할** — `ALLOWED_ROLES`·`renderAtomicForRole`에 직결 (예: `focus-block`, `now-bar`).
- **`semanticConcept`** (선택): Generate API가 쓰는 **의도형 id** (`SEMANTIC_COMPONENT_VOCAB` 키). 해석 후에는 `_semanticId`로 보존될 수 있음.
- **`slot`**: 콘텐츠 병합의 **안정 키** ([app/scenes.js](../app/scenes.js) `renderPipelineResponse` → `_resolveChildContent`가 slot 우선).

브리지 표(팔레트 → 원자, 시맨틱 → 원자)는 [genui_schema_bridge.v1.json](../figma-refs/genui_schema_bridge.v1.json)에 유지합니다. 브라우저에서 `DesignDoc.hydrateFromPipelineBundle`가 `plan.requiredComponents`만으로 노드를 만들 때는 기본적으로 `role`이 `unknown`일 수 있으므로, 선택적으로 `window.GENUI_SCHEMA_BRIDGE`에 이 JSON 내용을 할당하면 같은 테이블로 `paletteId → atomic` 역할을 채웁니다.

## 최상위 번들: `genuiBundleVersion`

저장·전송용 통합 객체 최상단에 다음을 둡니다.

| 필드 | 필수 | 설명 |
|------|------|------|
| `genuiBundleVersion` | 예 | 현재 `"1"` |
| `kind` | 권장 | `"pipelineResult"` \| `"designDoc"` \| `"themeOnly"` \| `"composed"` |
| `surface` / `surfaceType` | 선택 | 파이프라인과 동일한 surface 식별 |
| `meta` | 선택 | 시나리오 id, 타임스탬프, 빌드 등 자유 메타 |

과거 snake_case 필드는 로드 전 **정규화 레이어**([schema_normalizer.js](../schema_normalizer.js))를 통과시키면 읽을 수 있습니다.

## 노드(DesignDoc `nodes[]`) 권장 형태

| 필드 | 설명 |
|------|------|
| `id` | DOM `data-node-id`와 동일한 안정 id |
| `role` | 원자 역할 |
| `paletteId` | 레지스트리 팔레트 id (없으면 `type`으로 역호환) |
| `type` | **레거시**: 팔레트 id를 넣던 필드. 새 코드는 `paletteId` 우선 |
| `semanticConcept` | Generate 시맨틱 id (없으면 `null`) |
| `state`, `zone`, `props`, `styles`, `content`, `html` | 기존과 동일 |

## 레이아웃 vs 콘텐츠 분리 (재생용 패킷)

화면을 **파일 하나로 재현**하려면 아래 **삼분할**을 한 번에 저장하는 것을 권장합니다.

1. **`layoutPlan`** — 순수 구조 (`groups`, `children`, `componentId`, visibility 등).
2. **`plan.requiredComponents`** (또는 정규화된 동일 스냅샷) — `slot`, `componentType`(= `paletteId`), 플래너 `role`(과제 단위 subject/context 등), `priority`, `content` 힌트.
3. **`contentBySlot`** — `slot` → `{ label, value, icon, ... }` 실제 문자열 (렌더에 병합되는 값).

런타임은 `layoutPlan` + `requiredComponents`의 inline `content`와 `contentBySlot`을 병합합니다. 저장 시 한 축만 있으면 재로드 후 빈 카드처럼 보일 수 있습니다.

### 재저장·로드 검증 체크리스트 (persist flow)

1. **`genuiBundleVersion`** 존재 및 `"1"` 여부 확인.
2. **정규화**: selector/composer 출력이면 Node에서 `normalizeSelectorOutput` / `normalizeComposerOutput`를 한 번에 적용하려면 [genui_bundle_load.js](../genui_bundle_load.js)의 `normalizePersistedBundle(raw)`를 사용합니다.
3. **`layoutPlan` 일관성**: 각 `children[].componentId`가 레지스트리에 있고(`component_registry.json`), 파이프라인 검증(`pipeline.validatePlan` 등)을 통과하는지 확인.
4. **`slot` 키**: `requiredComponents[].slot`와 `contentBySlot`의 키 집합이 대응하는지 검토 (없어도 되는 슬롯은 문서화).
5. **DesignDoc 재구성 시**: 가능하면 렌더 직후의 `designDoc`-형 `nodes`(원자 `role` + `paletteId`)를 함께 저장 — `requiredComponents`만으로는 원자 `role`이 없을 수 있어 `role: 'unknown'` 스켈레톤이 될 수 있음.
6. **기계 검증(선택)**: [genui_bundle.v1.schema.json](../figma-refs/schemas/genui_bundle.v1.schema.json) 또는 `node scripts/validate-genui-bundle.mjs <file.json>`.

## 브리지 테이블 동기화 절차

| 소스 | 수정 시 동기 대상 |
|------|-------------------|
| [app/scenes.js](../app/scenes.js) `PIPELINE_BODY_ATOMIC_ROLE`, `PIPELINE_CHROME_ATOMIC_ROLE` | [genui_schema_bridge.v1.json](../figma-refs/genui_schema_bridge.v1.json)의 `body`, `chrome` |
| [server.js](../server.js) `SEMANTIC_COMPONENT_VOCAB` | 동 JSON의 `semanticToAtomic` |
| [figma-refs/component_registry.json](../figma-refs/component_registry.json) | 새 `paletteId` 추가 시 레이아웃·플래너와 함께 검증 |

PR 리뷰 시 위 세 곳과 JSON 드리프트를 한 번에 보면 됩니다.

## DesignDoc·Generate·파이프라인 정렬

- **Generate / sanitizeRenderModel**: `components[].role`은 시맨틱 또는 원자; 시맨틱은 서버에서 원자로 풀리고 `_semanticId`가 붙습니다.
- **파이프라인 Path A→B**: `componentId` + 브리지 → `dataset.atomicRole` / 원자 렌더.
- **DesignDoc**: `hydrateFromRenderModel`·`hydrateFromPipelineResponse` 경로에서 `paletteId`·`semanticConcept`를 채웁니다. `_registerNodeWithDesignDoc`는 원자 `role`을 우선합니다.

## 스키마 파일

- JSON Schema 초안: [figma-refs/schemas/genui_bundle.v1.schema.json](../figma-refs/schemas/genui_bundle.v1.schema.json)

## 디버깅: 정규화 폴백 통계

LLM 출력이 enum 밖이거나 필드가 잘리면 [schema_normalizer.js](../schema_normalizer.js)의 **`getFallbackStats()`** / **`withCollector(fn)`** 로 프로세스·호출 단위 대체 횟수를 확인할 수 있습니다. `LOG_FALLBACKS=1`이면 stderr에 `[FALLBACK]` 로그가 남습니다.

## 예시 번들 (최소)

```json
{
  "genuiBundleVersion": "1",
  "kind": "pipelineResult",
  "surfaceType": "lockscreen",
  "layoutPlan": {
    "groups": []
  },
  "plan": {
    "requiredComponents": [
      {
        "slot": "hero",
        "componentType": "navigation_turn_card",
        "role": "subject",
        "priority": 1,
        "content": { "label": "200 m", "value": "우회전" }
      }
    ]
  },
  "contentBySlot": {
    "hero": { "label": "200 m", "value": "우회전" }
  },
  "designDoc": {
    "surfaceType": "lockscreen",
    "layout": {},
    "nodes": [
      {
        "id": "n1",
        "role": "now-bar",
        "paletteId": "navigation_turn_card",
        "type": "navigation_turn_card",
        "semanticConcept": null,
        "props": { "slot": "hero" },
        "content": {}
      }
    ]
  }
}
```
