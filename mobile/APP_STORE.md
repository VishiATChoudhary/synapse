# Synapse on iPhone without App Review risk

Two rules: never depend on the App Store, and build the App Store version so a reviewer has nothing to reject.
Guideline numbers refer to the App Store Review Guidelines as of October 2026.

## 1. Ways onto a phone that skip App Review entirely

| Path | Apple account | Review | Good for |
| --- | --- | --- | --- |
| Expo Go (`npm run mobile`, scan the QR) | none | none | development, today |
| Web build (`npm run build:web`), added to the home screen | none | none | fallback for anyone, any phone |
| Development or ad hoc build on registered devices (EAS) | paid | none | your own phone with push, up to 100 devices |
| TestFlight internal testing | paid | none | you and your team (up to 100 people) |
| TestFlight external testing | paid | light beta review | friends and early users |
| App Store | paid | full review | public launch, later |

The same code runs on all of them: Expo targets iOS, Android and web from one codebase.
Android ships through Google Play or a plain APK, with no Apple involvement.

## 2. Built in so review has nothing to reject

| Risk | Guideline | What the app does |
| --- | --- | --- |
| Reviewer has no Synapse computer | 2.1, 4.2.3 | A demo account for the review notes, plus "look around with sample agents" on the sign-in screen, which works with no computer. |
| Login rules and account deletion | 4.8, 5.1.1(v) | Email and password only, no Google, GitHub or X buttons in the iOS app (those would require Sign in with Apple too). Accounts made in the app can be deleted in the app: settings, delete account. |
| Prompts going to AI providers | 5.1.2(i) | A consent sheet before the first prompt names where data goes (your computer, then Anthropic, OpenAI or Google). It can be withdrawn in settings. |
| Privacy policy reachable in the app | 5.1.1(i) | Settings, then "privacy policy" (https://app.heysynapse.dev/privacy). |
| Downloading code | 2.5.2 | The phone only shows data and sends text. It never runs code or HTML from the computer. Keep agent output rendered as text, not in a WebView. |
| Remote desktop rules (LAN only) | 4.2.7 | It isn't a screen mirror: it's a native app for your own computer's agents, like an SSH or Home Assistant client. Don't add screen streaming to the iOS build without reading 4.2.7 again. |
| User-generated content between people | 1.2 | No multiplayer, friends or sharing in the iOS build. If added, it needs report and block. |
| Payments | 3.1.1, 3.1.3(f) | The app is free. No prices, plans, upgrade buttons or links to pay anywhere in it. |
| Encryption export questions | export compliance | `ITSAppUsesNonExemptEncryption: false` in app.json (TLS only). |
| Push permission | 5.1.2 | Ask only when the user turns on notifications. The app must work fully without them. |
| Name clash | 2.3.7 | "Synapse" is taken on the App Store. Use the store name "Synapse Agents" and keep "Synapse" as the home-screen name. |
| Incomplete app | 2.1 | No placeholder screens or "coming soon" in a submitted build. |
| Placeholder icon, iPad layout | 2.1, 2.4.1 | Real Synapse icon (square, no alpha) and splash. iPhone only (`supportsTablet: false`), so there are no iPad screenshots or layouts to review. |

## 3. Before submitting

- [ ] Add a "phone app" section to the privacy policy: what pairing stores, and that prompts pass through the relay without being kept.
- [ ] Add a support email to the privacy page and to the App Store metadata.
- [ ] Fill in the privacy nutrition labels: data is not used for tracking. Content is linked to the user only through their own computer.
- [ ] Use screenshots from the demo mode, not real agent transcripts.
- [ ] Test on a real device through TestFlight first.

## 4. Building and shipping (no Xcode needed)

EAS builds on Expo's Macs and creates the Apple certificates and provisioning for you.

```sh
cd mobile
npx eas-cli login          # once, free Expo account
npx eas-cli init           # once, links the project
npm run testflight         # build for iOS and upload to TestFlight
```

The build asks for your Apple ID once, then reuses the credentials. Add yourself as an internal tester in App Store Connect and the build installs through the TestFlight app, with no review.

## 5. Review notes (paste into App Store Connect)

> Synapse Agents is the companion app for Synapse, a free desktop app that runs coding agents (Claude Code, Codex, Gemini CLI) on the user's own computer. The phone shows those agents, starts new ones and sends them messages. All work runs on the user's computer.
>
> To review without a computer: on the sign-in screen tap "look around with sample agents" (open any agent, send a message, answer the "needs you" card, start a new agent with "+ new agent"). Nothing leaves the device there.
>
> Sign in with the demo account below, or tap "look around with sample agents" on the sign-in screen. A real computer appears once Synapse on it is signed in to the same account and allows the phone.
>
> Demo account: (fill in before submitting)
