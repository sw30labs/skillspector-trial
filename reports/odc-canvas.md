# SkillSpector Security Report

**Skill:** unknown  
**Source:** `~/Code/SKILLS/odc-canvas`  
**Scanned:** 2026-06-12 10:52:56 UTC  

## Risk Assessment

| Metric | Value |
|--------|-------|
| Score | 100/100 |
| Severity | CRITICAL |
| Recommendation | DO NOT INSTALL |

## Components (44)

| File | Type | Lines | Executable |
|------|------|-------|------------|
| `odc-canvas-v1.3.0.skill` | other | 3696 | No |
| `odc-canvas-v1.3.1.skill` | other | 3860 | No |
| `odc-canvas-v1.3.1/LICENSE` | other | 197 | No |
| `odc-canvas-v1.3.1/README.md` | markdown | 65 | No |
| `odc-canvas-v1.3.1/SKILL.md` | markdown | 1097 | No |
| `odc-canvas-v1.3.1/assets/schema.json` | json | 1479 | No |
| `odc-canvas-v1.3.1/examples/sample-canvas.json` | json | 414 | No |
| `odc-canvas-v1.3.1/references/canvas-field-definitions.md` | markdown | 270 | No |
| `odc-canvas-v1.3.1/references/consistency-check-specs.md` | markdown | 428 | No |
| `odc-canvas-v1.3.1/references/deployment-readiness.md` | markdown | 322 | No |
| `odc-canvas-v1.3.1/references/docx-template-spec.md` | markdown | 480 | No |
| `odc-canvas-v1.3.1/references/meridian-example.md` | markdown | 318 | No |
| `odc-canvas-v1.3.1/references/pushback-patterns.md` | markdown | 550 | No |
| `odc-canvas-v1.3.1/references/quality-rubric.md` | markdown | 348 | No |
| `odc-canvas-v1.3.1/scripts/consistency-checks.mjs` | other | 1067 | No |
| `odc-canvas-v1.3.1/scripts/generate-baseline-record.mjs` | other | 525 | No |
| `odc-canvas-v1.3.1/scripts/generate-docx.mjs` | other | 780 | No |
| `odc-canvas-v1.3.1/scripts/generate-json.mjs` | other | 244 | No |
| `odc-canvas-v1.3.1/scripts/install-deps.sh` | shell | 33 | Yes |
| `odc-canvas-v1.3.1/scripts/package.json` | json | 16 | No |
| `odc-canvas-v1.3.1/scripts/patch20260417.md` | markdown | 65 | No |
| `odc-canvas-v1.3.1/scripts/submit-to-pe.sh` | shell | 241 | Yes |
| `odc-canvas-v1.4.0/odc-canvas-v1.4.0.zip` | other | 3865 | No |
| `odc-canvas-v1.4.0/odc-canvas/LICENSE` | other | 197 | No |
| `odc-canvas-v1.4.0/odc-canvas/README.md` | markdown | 67 | No |
| `odc-canvas-v1.4.0/odc-canvas/SKILL.md` | markdown | 1162 | No |
| `odc-canvas-v1.4.0/odc-canvas/assets/schema.json` | json | 2102 | No |
| `odc-canvas-v1.4.0/odc-canvas/examples/sample-canvas.json` | json | 424 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/canonical-components.md` | markdown | 171 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/canvas-field-definitions.md` | markdown | 360 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/consistency-check-specs.md` | markdown | 428 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/deployment-readiness.md` | markdown | 330 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/docx-template-spec.md` | markdown | 480 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/meridian-example.md` | markdown | 90 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/pushback-patterns.md` | markdown | 550 | No |
| `odc-canvas-v1.4.0/odc-canvas/references/quality-rubric.md` | markdown | 348 | No |
| `odc-canvas-v1.4.0/odc-canvas/scripts/consistency-checks.mjs` | other | 1067 | No |
| `odc-canvas-v1.4.0/odc-canvas/scripts/generate-baseline-record.mjs` | other | 520 | No |
| `odc-canvas-v1.4.0/odc-canvas/scripts/generate-docx.mjs` | other | 718 | No |
| `odc-canvas-v1.4.0/odc-canvas/scripts/generate-json.mjs` | other | 244 | No |
| `odc-canvas-v1.4.0/odc-canvas/scripts/install-deps.sh` | shell | 33 | Yes |
| `odc-canvas-v1.4.0/odc-canvas/scripts/package.json` | json | 16 | No |
| `odc-canvas-v1.4.0/odc-canvas/scripts/submit-to-pe.sh` | shell | 241 | Yes |
| `odc-canvas.zip` | other | 3757 | No |

## Issues (38)

### 🟡 MEDIUM: E1

**Location:** `odc-canvas-v1.3.1/scripts/submit-to-pe.sh:113`  
**Confidence:** 70%  

**Message:** External Transmission

**Remediation:** Verify the destination URL is trusted and necessary. Remove or replace with documented APIs. Ensure no secrets, tokens, or PII are transmitted.

---

### 🟡 MEDIUM: E1

**Location:** `odc-canvas-v1.4.0/odc-canvas/scripts/submit-to-pe.sh:113`  
**Confidence:** 70%  

**Message:** External Transmission

**Remediation:** Verify the destination URL is trusted and necessary. Remove or replace with documented APIs. Ensure no secrets, tokens, or PII are transmitted.

---

### 🟢 LOW: EA3

**Location:** `odc-canvas-v1.3.1/LICENSE:27`  
**Confidence:** 70%  

**Message:** Scope Creep

**Remediation:** Limit the skill's scope to its documented purpose. Remove instructions that enable the agent to perform actions outside its stated functionality.

---

### 🟢 LOW: EA3

**Location:** `odc-canvas-v1.3.1/LICENSE:32`  
**Confidence:** 70%  

**Message:** Scope Creep

**Remediation:** Limit the skill's scope to its documented purpose. Remove instructions that enable the agent to perform actions outside its stated functionality.

---

### 🟢 LOW: EA3

**Location:** `odc-canvas-v1.3.1/LICENSE:156`  
**Confidence:** 70%  

**Message:** Scope Creep

**Remediation:** Limit the skill's scope to its documented purpose. Remove instructions that enable the agent to perform actions outside its stated functionality.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/canvas-field-definitions.md:81`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/canvas-field-definitions.md:184`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/deployment-readiness.md:75`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/deployment-readiness.md:245`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/deployment-readiness.md:297`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/docx-template-spec.md:173`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/pushback-patterns.md:123`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.3.1/references/quality-rubric.md:31`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟢 LOW: EA3

**Location:** `odc-canvas-v1.4.0/odc-canvas/LICENSE:27`  
**Confidence:** 70%  

**Message:** Scope Creep

**Remediation:** Limit the skill's scope to its documented purpose. Remove instructions that enable the agent to perform actions outside its stated functionality.

---

### 🟢 LOW: EA3

**Location:** `odc-canvas-v1.4.0/odc-canvas/LICENSE:32`  
**Confidence:** 70%  

**Message:** Scope Creep

**Remediation:** Limit the skill's scope to its documented purpose. Remove instructions that enable the agent to perform actions outside its stated functionality.

---

### 🟢 LOW: EA3

**Location:** `odc-canvas-v1.4.0/odc-canvas/LICENSE:156`  
**Confidence:** 70%  

**Message:** Scope Creep

**Remediation:** Limit the skill's scope to its documented purpose. Remove instructions that enable the agent to perform actions outside its stated functionality.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/canvas-field-definitions.md:110`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/canvas-field-definitions.md:169`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/deployment-readiness.md:83`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/deployment-readiness.md:253`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/deployment-readiness.md:305`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/docx-template-spec.md:173`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/pushback-patterns.md:123`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/references/quality-rubric.md:31`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🔴 HIGH: MP3

**Location:** `odc-canvas-v1.3.1/SKILL.md:1010`  
**Confidence:** 80%  

**Message:** Memory Manipulation

**Remediation:** Protect agent memory and state from modification by untrusted content. Use read-only memory for critical instructions and validate all state changes.

---

### 🔴 HIGH: MP3

**Location:** `odc-canvas-v1.4.0/odc-canvas/SKILL.md:1066`  
**Confidence:** 80%  

**Message:** Memory Manipulation

**Remediation:** Protect agent memory and state from modification by untrusted content. Use read-only memory for critical instructions and validate all state changes.

---

### 🟡 MEDIUM: RA2

**Location:** `odc-canvas-v1.3.1/SKILL.md:297`  
**Confidence:** 60%  

**Message:** Session Persistence

**Remediation:** Remove any persistence mechanisms (cron jobs, startup scripts, state files). Skills should not maintain state across sessions without explicit user consent.

---

### 🟡 MEDIUM: RA2

**Location:** `odc-canvas-v1.4.0/odc-canvas/SKILL.md:301`  
**Confidence:** 60%  

**Message:** Session Persistence

**Remediation:** Remove any persistence mechanisms (cron jobs, startup scripts, state files). Skills should not maintain state across sessions without explicit user consent.

---

### 🟢 LOW: SC1

**Location:** `odc-canvas-v1.3.1/scripts/package.json:13`  
**Confidence:** 40%  

**Message:** Unpinned Dependencies

**Remediation:** Pin all dependency versions in requirements.txt or pyproject.toml. Use exact versions (==) or compatible ranges. Run pip-audit regularly.

---

### 🟢 LOW: SC1

**Location:** `odc-canvas-v1.3.1/scripts/package.json:14`  
**Confidence:** 40%  

**Message:** Unpinned Dependencies

**Remediation:** Pin all dependency versions in requirements.txt or pyproject.toml. Use exact versions (==) or compatible ranges. Run pip-audit regularly.

---

### 🟢 LOW: SC1

**Location:** `odc-canvas-v1.4.0/odc-canvas/scripts/package.json:13`  
**Confidence:** 40%  

**Message:** Unpinned Dependencies

**Remediation:** Pin all dependency versions in requirements.txt or pyproject.toml. Use exact versions (==) or compatible ranges. Run pip-audit regularly.

---

### 🟢 LOW: SC1

**Location:** `odc-canvas-v1.4.0/odc-canvas/scripts/package.json:14`  
**Confidence:** 40%  

**Message:** Unpinned Dependencies

**Remediation:** Pin all dependency versions in requirements.txt or pyproject.toml. Use exact versions (==) or compatible ranges. Run pip-audit regularly.

---

### 🟢 LOW: SC4

**Location:** `odc-canvas-v1.3.1/scripts/package.json:14`  
**Confidence:** 60%  

**Message:** Known Vulnerable Dependency: uuid==13.0.0 — 1 advisory(ies): CVE-2026-41907 (uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided)

**Remediation:** Update the dependency to a patched version that addresses the known CVE. Check OSV (osv.dev) or NVD for details on the vulnerability.

---

### 🟢 LOW: SC4

**Location:** `odc-canvas-v1.4.0/odc-canvas/scripts/package.json:14`  
**Confidence:** 60%  

**Message:** Known Vulnerable Dependency: uuid==13.0.0 — 1 advisory(ies): CVE-2026-41907 (uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided)

**Remediation:** Update the dependency to a patched version that addresses the known CVE. Check OSV (osv.dev) or NVD for details on the vulnerability.

---

### 🔴 HIGH: TM1

**Location:** `odc-canvas-v1.3.0.skill:775`  
**Confidence:** 85%  

**Message:** Tool Parameter Abuse

**Remediation:** Validate all tool parameters against an allowlist. Reject dangerous parameter values (shell=True, --force, -rf /) and use safe defaults.

---

### 🔴 HIGH: TM1

**Location:** `odc-canvas-v1.3.1.skill:106`  
**Confidence:** 85%  

**Message:** Tool Parameter Abuse

**Remediation:** Validate all tool parameters against an allowlist. Reject dangerous parameter values (shell=True, --force, -rf /) and use safe defaults.

---

### 🔴 HIGH: TM1

**Location:** `odc-canvas-v1.4.0/odc-canvas-v1.4.0.zip:934`  
**Confidence:** 85%  

**Message:** Tool Parameter Abuse

**Remediation:** Validate all tool parameters against an allowlist. Reject dangerous parameter values (shell=True, --force, -rf /) and use safe defaults.

---

### 🔴 HIGH: TM1

**Location:** `odc-canvas.zip:98`  
**Confidence:** 85%  

**Message:** Tool Parameter Abuse

**Remediation:** Validate all tool parameters against an allowlist. Reject dangerous parameter values (shell=True, --force, -rf /) and use safe defaults.

---

## Metadata

- **Executable Scripts:** Yes

*Generated by SkillSpector v2.1.3*