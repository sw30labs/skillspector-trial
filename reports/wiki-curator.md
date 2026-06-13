# SkillSpector Security Report

**Skill:** unknown  
**Source:** `~/Code/SKILLS/wiki-curator`  
**Scanned:** 2026-06-12 10:53:04 UTC  

## Risk Assessment

| Metric | Value |
|--------|-------|
| Score | 100/100 |
| Severity | CRITICAL |
| Recommendation | DO NOT INSTALL |

## Components (24)

| File | Type | Lines | Executable |
|------|------|-------|------------|
| `patches/SCHEMA.md` | markdown | 107 | No |
| `patches/wiki-curator-patch-1.1.patch` | other | 1144 | No |
| `patches/wiki-curator-patch-1.2/scripts/detect_changes.py` | python | 346 | Yes |
| `patches/wiki-curator-patch-1.2/scripts/generate_sitemap.py` | python | 398 | Yes |
| `patches/wiki-home-sync-2026-04-15.patch` | other | 83 | No |
| `patches/wiki-link-sweep-2026-04-15.patch` | other | 129 | No |
| `patches/wiki-sitemap-article-shape-2026-04-15.patch` | other | 131 | No |
| `patches/wiki-sitemap-split-2026-04-15.patch` | other | 416 | No |
| `patches/wiki-stacks-split-2026-04-15.patch` | other | 468 | No |
| `patches/wiki-taxonomy-migration-2026-04-15.patch` | other | 1278 | No |
| `patches/wiki-update-2026-04-15.patch` | other | 432 | No |
| `wiki-curator-1.0.skill` | other | 550 | No |
| `wiki-curator-1.2.skill` | other | 559 | No |
| `wiki-curator-1.3.skill` | other | 586 | No |
| `wiki-curator-1.4.skill` | other | 836 | No |
| `wiki-curator-1.5.skill` | other | 944 | No |
| `wiki-curator-v2.7.0.skill` | other | 967 | No |
| `wiki-curator/CHANGELOG.md` | markdown | 72 | No |
| `wiki-curator/SKILL.md` | markdown | 779 | No |
| `wiki-curator/references/SCHEMA.template.md` | markdown | 111 | No |
| `wiki-curator/references/wiki-structure.md` | markdown | 159 | No |
| `wiki-curator/scripts/detect_changes.py` | python | 484 | Yes |
| `wiki-curator/scripts/generate_sitemap.py` | python | 384 | Yes |
| `wiki-curator/scripts/taxonomy.py` | python | 212 | Yes |

## Issues (13)

### 🟡 MEDIUM: AST4

**Location:** `patches/wiki-curator-patch-1.2/scripts/detect_changes.py:42–45`  
**Confidence:** 70%  

**Message:** subprocess module call

**Remediation:** Use subprocess.run() with shell=False and an explicit argument list. Validate all inputs and avoid passing user-controlled data to commands.

---

### 🟡 MEDIUM: AST4

**Location:** `patches/wiki-curator-patch-1.2/scripts/detect_changes.py:68–71`  
**Confidence:** 70%  

**Message:** subprocess module call

**Remediation:** Use subprocess.run() with shell=False and an explicit argument list. Validate all inputs and avoid passing user-controlled data to commands.

---

### 🟡 MEDIUM: AST4

**Location:** `wiki-curator/scripts/detect_changes.py:48–51`  
**Confidence:** 70%  

**Message:** subprocess module call

**Remediation:** Use subprocess.run() with shell=False and an explicit argument list. Validate all inputs and avoid passing user-controlled data to commands.

---

### 🟡 MEDIUM: AST4

**Location:** `wiki-curator/scripts/detect_changes.py:74–77`  
**Confidence:** 70%  

**Message:** subprocess module call

**Remediation:** Use subprocess.run() with shell=False and an explicit argument list. Validate all inputs and avoid passing user-controlled data to commands.

---

### 🟡 MEDIUM: E1

**Location:** `patches/wiki-curator-patch-1.2/scripts/detect_changes.py:43`  
**Confidence:** 60%  

**Message:** External Transmission

**Remediation:** Verify the destination URL is trusted and necessary. Remove or replace with documented APIs. Ensure no secrets, tokens, or PII are transmitted.

---

### 🟡 MEDIUM: E1

**Location:** `wiki-curator/SKILL.md:154`  
**Confidence:** 50%  

**Message:** External Transmission

**Remediation:** Verify the destination URL is trusted and necessary. Remove or replace with documented APIs. Ensure no secrets, tokens, or PII are transmitted.

---

### 🟡 MEDIUM: E1

**Location:** `wiki-curator/scripts/detect_changes.py:49`  
**Confidence:** 60%  

**Message:** External Transmission

**Remediation:** Verify the destination URL is trusted and necessary. Remove or replace with documented APIs. Ensure no secrets, tokens, or PII are transmitted.

---

### 🟡 MEDIUM: EA2

**Location:** `wiki-curator/SKILL.md:69`  
**Confidence:** 75%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🟡 MEDIUM: EA2

**Location:** `wiki-curator/SKILL.md:55`  
**Confidence:** 80%  

**Message:** Autonomous Decision Making

**Remediation:** Add human-in-the-loop confirmation for destructive, irreversible, or high-impact operations. Never auto-execute commands that modify files, send data, or alter system state.

---

### 🔴 HIGH: OH1

**Location:** `patches/wiki-curator-patch-1.2/scripts/detect_changes.py:42`  
**Confidence:** 95%  

**Message:** Unvalidated Output Injection

**Remediation:** Validate and sanitize all model output before using it in downstream contexts. Use parameterized queries for SQL, shell quoting for commands, and HTML encoding for web output.

---

### 🔴 HIGH: OH1

**Location:** `wiki-curator/scripts/detect_changes.py:48`  
**Confidence:** 95%  

**Message:** Unvalidated Output Injection

**Remediation:** Validate and sanitize all model output before using it in downstream contexts. Use parameterized queries for SQL, shell quoting for commands, and HTML encoding for web output.

---

### 🔴 HIGH: PE3

**Location:** `patches/wiki-curator-patch-1.1.patch:454`  
**Confidence:** 60%  

**Message:** Credential Access

**Remediation:** Remove references to credential paths. Use environment variables or secrets managers. For docs, use placeholder paths (e.g., /path/to/config). Never load .env or token files in production code paths.

---

### 🟢 LOW: SC2

**Location:** `wiki-curator/SKILL.md:154`  
**Confidence:** 15%  

**Message:** External Script Fetching

**Remediation:** Avoid downloading and executing remote scripts. Use trusted packages from PyPI/npm. If remote fetch is required, verify checksums and use HTTPS.

---

## Metadata

- **Executable Scripts:** Yes

*Generated by SkillSpector v2.1.3*