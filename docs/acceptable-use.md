# Acceptable Use Policy (AUP)

Enkaku is a **device farm for QA and test automation**: running automated tests against Android applications on physical devices. This document sets out the legitimate boundaries of use and how the product supports them technically.

## What this product is for

- Testing **your own** applications (or applications you have written permission to test) across many devices at once.
- Regression tests, smoke tests, and compatibility testing across Android versions.
- **Testing your own automation-detection systems** (red-teaming your own detectors): run scenarios from the farm, see which get flagged and which slip through, then improve the detectors.

## What is not allowed

- Operating accounts or services **belonging to other people** without permission, including bulk account creation, metric manipulation, or working around third-party anti-fraud systems.
- Violating the Terms of Service of any application or service you reach through the farm.
- Accessing devices that are not yours or not under your lawful control.

## How the product supports these boundaries technically

**Instrumentation, not disguise.** Traffic originating from the farm is **marked by default**. That is deliberate: if you hold both sides (the detector and the farm), what helps is the feedback — which scenarios were flagged and which were not — rather than hiding where the traffic came from.

**Features that are commonly misread:**

- **UHID input mode** (hardware-like) exists so tests take **the application's real code path**. Many apps treat API-injected input differently from a genuine touch; testing through the wrong path produces meaningless results.
- **Timing jitter** exists because applications often have separate paths for fast robotic interaction and human interaction. This is standard QA practice for test realism, not a disguise tool.

Both features are documented in the context of test realism. Using them to deceive systems belonging to other parties violates this AUP.

## Physical devices and privacy

Enkaku is self-hosted: pre-release builds, test credentials, and artifacts never leave your infrastructure unless you configure it that way yourself.

For multi-user farms, enable the device reset between leases so accounts and credentials do not leak between users.

## Enforcement

Agreement to this AUP is requested once, when the first admin account is created. Reported violations may result in revocation of a commercial licence.
