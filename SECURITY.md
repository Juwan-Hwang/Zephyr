# Security Policy & Vulnerability Disclosure

Zephyr takes the security of our software and users seriously. We appreciate the efforts of security researchers and community developers who discover and responsibly report security vulnerabilities.

This document outlines our vulnerability disclosure policy, response timeline, severity classification, CVE assignment process, recognition for contributors, and core security design principles.

---

## Supported Versions

Only the latest stable release receives security updates. Users are strongly encouraged to upgrade to the latest version.

| Version / Branch | Supported | Notes |
| :--- | :---: | :--- |
| `Latest stable release` | ✅ | Actively supported with security patches |
| `Previous releases` | ❌ | End of Life (EOL) — please update to the latest version |

---

## Reporting a Vulnerability

> [!WARNING]
> **Please do NOT open public GitHub Issues, Discussions, or pull requests for security vulnerabilities.**
> Public disclosure before a fix is available puts all users at risk.

- **Preferred Languages**: English, Chinese (中文)

### Primary Channel: GitHub Private Vulnerability Reporting (PVR)

Zephyr has enabled GitHub's **Private Vulnerability Reporting**. This is the preferred, secure method to submit reports:

1. Navigate to the **[Security tab](https://github.com/Juwan-Hwang/Zephyr/security)** of the repository.
2. Click **[Report a vulnerability](https://github.com/Juwan-Hwang/Zephyr/security/advisories/new)**.
3. Fill in the advisory details with a clear title, description, reproduction steps, and proof of concept.

### Fallback Channel: Direct Email

If you are unable to use GitHub Private Vulnerability Reporting, you can report via email:

- **Email**: `juwan.hwang@proton.me`
- **Subject**: `[SECURITY REPORT] <Vulnerability Summary>`
- **GPG Key**: Available upon request for encrypted communication.

---

## What to Include in Your Report

To help us triage and resolve the issue quickly, please provide:

- **Affected Component**: (e.g., Prism Sandbox, SSRF Filter, Deep Link Handler, Tauri IPC, YAML/Config Parser, Auto-Updater).
- **Vulnerability Type**: (e.g., Sandbox Escape, SSRF Bypass, Config Injection, Remote Code Execution, Proxy/DNS Leak).
- **Affected Versions / OS**: (e.g., Windows 11, macOS Sequoia, Linux x64).
- **Step-by-Step Reproduction**: Detailed reproduction steps or a minimal Proof of Concept (PoC).
- **Impact Assessment**: What an attacker could achieve if the vulnerability is exploited.
- **Suggested Remediation (Optional)**: Recommended fix or mitigation if available.

---

## Severity Classification

We assess vulnerabilities based on potential impact and exploitability:

| Severity | Description & Examples |
| :--- | :--- |
| **Critical** | **Remote Code Execution & Full Compromise**<br>• Remote Code Execution (RCE) via malicious configs, subscriptions, or deep links<br>• Prism QuickJS engine sandbox escape or arbitrary system command execution<br>• Auto-updater signature verification bypass or malicious update injection |
| **High** | **Security Policy & Proxy/DNS Bypass**<br>• Proxy rule bypass or DNS leak prevention failure leading to silent traffic/IP leakage<br>• SSRF protection bypass accessing sensitive local network services<br>• Local privilege escalation or extraction of sensitive encrypted credentials/keys |
| **Medium** | **Controlled Tampering & Information Leakage**<br>• Unintended sensitive data leakage in logs or IPC responses<br>• Denial of Service (DoS) reachable via remote untrusted input<br>• Insecure temporary file handling leading to local race conditions |
| **Low** | **Defense-in-Depth & Minor Hardening**<br>• Minor security hardening improvements without direct exploitability<br>• Non-exploitable UI anomalies or client-side issues strictly contained within the WebView |

---

## Vulnerability Response Timeline

We follow the principles of **Coordinated Vulnerability Disclosure (CVD)**:

| Stage | Expected Timeframe | Action |
| :--- | :--- | :--- |
| **Initial Acknowledgment** | **Within 48 hours** | Confirm receipt of the report and begin initial assessment. |
| **Triage & Validation** | **Within 5 business days** | Validate exploitability, assign severity, and draft an advisory. |
| **Fix Development** | **Within 14–30 days** | Develop and test the patch. When appropriate, maintainers may collaborate with the reporter in a private fork to verify the fix. |
| **Coordinated Disclosure** | **Release Day** | Publish the patched release alongside the security advisory. Public disclosure will occur after a fix is available and coordinated with the reporter. CVE details will be included when available. |

---

## CVE Assignment Process

Zephyr follows the official standard CVE process:

- **GitHub as CNA**: GitHub is an authorized **CVE Numbering Authority (CNA)**.
- **CVE Requests**: GitHub Security Advisories may be used to request a CVE identifier through GitHub's CNA program for qualifying vulnerabilities.
- **Ecosystem Publication**: Once assigned and the advisory is published, the CVE record will be published through the CVE ecosystem and may be indexed by downstream vulnerability databases and security tools, depending on their ingestion policies.

---

## Recognition & Hall of Fame

We believe in giving proper credit to researchers who help make Zephyr safer:

1. **GitHub Advisory Credit**: You will be credited as a **Researcher / Contributor** directly in the published GitHub Security Advisory (GHSA) and associated CVE record, when assigned.
2. **Release Notes**: Your contribution will be highlighted in the GitHub Release Notes of the patched version.
3. **Security Hall of Fame**: Acknowledgment in the table below.

### Security Hall of Fame

We extend our sincere gratitude to the following researchers for responsibly disclosing vulnerabilities:

| Date | Researcher | Component / Vulnerability | CVE / Advisory |
| :---: | :---: | :---: | :---: |
| - | *No reports published yet* | - | - |

---

## Scope

### In-Scope

- **Sandbox Escapes & Execution**: Breaking out of QuickJS / Prism script sandboxes or executing arbitrary code.
- **Configuration & Policy Bypasses**: Malicious subscription payload injection, unsafe YAML deserialization, or proxy/DNS rule bypasses causing traffic leakage.
- **Network & SSRF**: Bypassing SSRF filters during subscription or rule downloads.
- **IPC & Privilege**: Unauthorized Tauri IPC invocation, command injection, or privilege escalation.
- **Integrity & Cryptography**: Auto-updater signature bypass, weak cryptography, or key material extraction.

### Out-of-Scope

- Attacks requiring full physical access or pre-existing root/admin malware on the target machine.
- Client-side / UI issues that cannot escape the WebView sandbox, abuse IPC bindings, or compromise system security.
- Denial of Service (DoS) caused by manually killing local client processes or modifying local config files directly.
- Vulnerabilities in third-party dependencies unless a realistic, reproducible exploit path exists in Zephyr.
- Social engineering, phishing, or spam attacks directed against project maintainers.

---

## Safe Harbor

We consider security research conducted under this policy to be **authorized** and in good faith. We commit not to pursue legal action against researchers who:

- Make a good faith effort to avoid privacy violations, data destruction, and service interruption.
- Give maintainers a standard **90-day coordinated disclosure window** (or until a fix is released) before public disclosure.
- Do not access, modify, or delete other users' data, configurations, or credentials without authorization.
- Only interact with their own accounts or test environments without compromising other users.

This policy does not authorize activities that violate applicable laws or impact third-party systems and services.

---

## Security Design Principles

Zephyr is built on the philosophy of **安全至上 (Security First)**:

- **Defense in Depth**: Multiple overlapping layers of protection across network boundaries (SSRF filters, DNS leak prevention and request redirection in TUN mode), parsing safety (recursive YAML sanitization), and execution limits.
- **Least Privilege & Isolation**: Untrusted Prism scripts, overrides, and plugins are designed to run within a constrained QuickJS sandbox with CPU, memory, string length, and recursion limits.
- **Secure by Default**: Cryptographic verification of update assets using Minisign Ed25519 signatures, strict host whitelisting, atomic file replacements, and safe memory guarantees powered by Rust.
- **Continuous Automated Verification**: Security-sensitive code changes undergo automated CI security checks, including CodeQL SAST, Semgrep, Trufflehog secret detection, cargo-deny dependency audits, and automated CycloneDX SBOM generation.

For an in-depth technical breakdown, please visit the **[Zephyr Security Architecture Wiki](https://github.com/Juwan-Hwang/Zephyr/wiki/Security)**.

---

## Security References

- [Security Design Overview](https://github.com/Juwan-Hwang/Zephyr#安全设计)
- [Zephyr Security Wiki](https://github.com/Juwan-Hwang/Zephyr/wiki/Security)
- [Prism Engine Sandboxing Specification](https://github.com/Juwan-Hwang/Zephyr/blob/main/FEATURES.md#prism-engine)
