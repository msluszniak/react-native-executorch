# Testing PR #1023 — Resource Fetcher Refactor

This branch (`test/pr-1023-resource-fetcher`) sits on top of [software-mansion/react-native-executorch#1023](https://github.com/software-mansion/react-native-executorch/pull/1023) rebased onto `main`, with a built-in test harness in [apps/bare-rn](apps/bare-rn) that exercises every behaviour the PR claims.

If you want to verify the PR without writing your own code, clone this branch, run the bare RN app, and tap the buttons in order. This document explains what each button does, what a passing run looks like, and how to interpret a failure.

## What the PR changes

- Extracts a shared `BaseResourceFetcherClass<TDownload>` into the core package containing the fetch loop, source dispatching, and pause/resume/cancel plumbing.
- Both `react-native-executorch-bare-resource-fetcher` and `react-native-executorch-expo-resource-fetcher` now extend that base; platform-specific mechanics live in `handlers.ts` next to each.
- `fetch()` returns `{ paths, wasDownloaded }` instead of `string[] | null`. `cancelFetching()` throws `DownloadInterrupted` (error code `118`) instead of resolving with `null`.
- Legacy FS still used — background/resumable downloads are WIP per the PR description.

## Setup

You need two working toolchains if you want to test both platforms. **Android alone is enough** to validate the refactor — the PR author tested on Android only.

```bash
git clone git@github.com:msluszniak/react-native-executorch.git
cd react-native-executorch
git checkout test/pr-1023-resource-fetcher
yarn install
yarn workspace react-native-executorch run prepare
yarn workspace react-native-executorch-bare-resource-fetcher run prepare
yarn workspace react-native-executorch-expo-resource-fetcher run prepare
```

### Android

```bash
cd apps/bare-rn
yarn start              # leave this running in one shell
yarn android            # build + install + launch in another shell
```

Requires an emulator or device running API 31+.

### iOS (Xcode 26.4)

```bash
cd apps/bare-rn/ios
pod install             # applies the Podfile post_install hook (see below)
cd ..
yarn start              # leave this running in one shell
yarn ios                # in another shell
```

**Xcode 26.4.1 currently breaks xcodebuild's destination resolver on some machines** (it stops advertising simulator destinations, complaining that the iOS 26.4 _device_ platform is missing even though only the simulator runtime is required). If you hit `Found no destinations for the scheme`, switch back to Xcode 26.4:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

### About the Podfile post_install hook

The [apps/bare-rn/ios/Podfile](apps/bare-rn/ios/Podfile) contains a test-branch workaround:

```ruby
if target.name == 'fmt' || target.name == 'RCT-Folly'
  config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
  config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'FMT_USE_CONSTEVAL=0'
end
```

Apple clang 21 (Xcode 26.4) rejects `fmt::basic_format_string`'s consteval path — this downgrades fmt/RCT-Folly to C++17 where `__cpp_consteval` is undefined, so fmt's header selects the non-consteval branch. Tracked upstream at [react-native#55601](https://github.com/facebook/react-native/issues/55601). Remove once a real RN fix ships.

## Running the tests

The harness ([apps/bare-rn/App.tsx](apps/bare-rn/App.tsx)) exposes eight buttons. Tap them in this order to exercise every codepath:

| #   | Button            | What it does                                                                                                                                                                                                                 |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `T1 fetch single` | `fetch()` a single remote file (`tokenizer.json`).                                                                                                                                                                           |
| T2  | `T2 fetch multi`  | `fetch()` two files; second should hit cache.                                                                                                                                                                                |
| T3  | `T3 cancel`       | Starts a ~1 GB model fetch, calls `cancelFetching()` 2 s later, asserts the fetch rejects with error code **118** (`DownloadInterrupted`).                                                                                   |
| T4  | `T4 model loads`  | Switches to a chat screen that calls `useLLM(LLAMA3_2_1B_SPINQUANT)`. Downloads the full PTE if not cached, loads it, and lets you run a prompt.                                                                             |
| T5  | `T5 list`         | Lists `listDownloadedFiles()` + `listDownloadedModels()`.                                                                                                                                                                    |
| T5  | `T5 delete`       | Calls `deleteResources()` for the two tokenizer files and asserts they disappear.                                                                                                                                            |
| T6  | `T6 background`   | Deletes the cached PTE, starts a fresh fetch, and watches `AppState`. You are expected to send the app to background (HOME on Android, ⌘⇧H on iOS sim) shortly after starting, then foreground it again and read the result. |
| T7  | `T7 pause/resume` | **iOS only.** Deletes the cached PTE, starts a fetch, after 3 s calls `pauseFetching()`, verifies progress is frozen for 3 s, calls `resumeFetching()`, verifies progress resumes for 4 s, then cancels. Fully automated.    |

Pause/resume is iOS-only by design — on Android the bare fetcher throws `ResourceFetcherPlatformNotSupported` (see [ResourceFetcher.ts](packages/bare-resource-fetcher/src/ResourceFetcher.ts)).

## Interpreting the results

The harness log is monospaced at the bottom of the Tests screen. **Green** lines mean an assertion passed, **red** lines mean something diverged from what the PR promises, white lines are informational.

### Expected output (passing run)

**T1**

```
T1: fetching tokenizer.json…
T1 OK  path=react-native-executorch/...tokenizer.json wasDownloaded=true
```

`wasDownloaded=true` the first time, `wasDownloaded=false` on later runs — this confirms the cache short-circuit.

**T2**

```
T2: fetching tokenizer + tokenizer_config…
T2 OK  count=2 wasDownloaded=[false,true]
    react-native-executorch/...tokenizer.json
    react-native-executorch/...tokenizer_config.json
```

`[false,true]` means tokenizer.json came from cache and tokenizer_config.json was downloaded fresh — proves idempotency works per-source, not per-batch.

**T3**

```
T3: starting LARGE model fetch; will cancel in 2s…
T3: cancelFetching() returned
T3 OK  threw code=118 msg="Download was canceled."
```

Error code `118` is `RnExecutorchErrorCode.DownloadInterrupted` — this is the new error-based cancel contract introduced by PR #1023. Anything else (code `undefined`, `null` result, no throw) is a regression.

**T4** — Chat screen shows `isReady=true` once the PTE download finishes. Tap `run prompt` and watch the `live:` field populate. Inference on a simulator/emulator is CPU-only and very slow (expect minutes for a handful of tokens). Seeing even a single token proves the downloaded PTE is intact and loadable.

**T5 list** — Show file and model counts. After T2 and T3, you should see `files=2 models=0` (the T3 cancel should have cleaned up the partial PTE, so no `.pte` remains on disk).

**T5 delete**

```
T5: deleting tokenizer + tokenizer_config…
T5 OK  tokenizer entries remaining=0
```

**T6 background** — Different behavior by platform:

- **Android**: download aborts shortly after background with `Software caused connection abort`. This is **correct** legacy-FS behavior — the PR explicitly flags background downloads as WIP. What you want to see:
  ```
  T6 AppState=background
  T6 ended: Failed to fetch resource from '...', context: Error: Software caused connection abort
  ```
- **iOS**: download continues through background and completes:
  ```
  T6 AppState=inactive
  T6 AppState=background
  T6 OK  downloaded=true  path=...
  ```
  This is because `@kesha-antonov/react-native-background-downloader` uses an `NSURLSession` background configuration on iOS.

**T7 pause/resume (iOS only)**

```
T7: progress before pause = 5.32%
T7: pauseFetching() returned
T7: progress after 3s paused = 5.32% (delta 0.000%)   ← pause actually held
T7: resumeFetching() returned
T7: progress after 4s resumed = 8.58% (delta 3.254%)  ← resume actually resumed
T7 done  fetch rejected with code=118 (expected)
```

The `delta` after pause should be ~0% (give or take floating-point noise). The `delta` after resume should be clearly positive. If the paused delta is nonzero, `pause()` didn't actually pause.

## What a failure looks like

| Symptom                                           | Likely meaning                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| T1 shows `wasDownloaded=false` on a fresh install | cache-hit path is returning the wrong flag, or a stale file wasn't cleaned up    |
| T3 log contains `T3 FAIL` (red)                   | cancel didn't throw, or threw the wrong code — the PR's error contract is broken |
| T5 list shows `models > 0` after T3 cancel        | cancel didn't clean up the partial .pte — cleanup regression                     |
| T5 delete shows `tokenizer entries remaining > 0` | `deleteResources()` didn't actually unlink the files                             |
| T7 shows nonzero delta during pause (in red)      | `pauseFetching()` returned but the download kept going — pause regression        |
| T7 shows zero/negative delta during resume        | `resumeFetching()` returned but the download didn't restart — resume regression  |

If anything shows up red, the failing log line already contains the discriminating data (error code, measured delta, etc.) — paste it into the PR review along with the device/OS and the full sequence of buttons you tapped.

## Clean slate between runs

If you want to re-run the full suite from zero:

- **Android:** `adb shell pm clear com.barern`
- **iOS:** `xcrun simctl uninstall booted org.reactjs.native.example.bare-rn` then `yarn ios` again

Or just tap **clear log** + **T5 delete** to remove tokenizer files. To clear the cached PTE use the T6 or T7 buttons (they wipe before fetching).

## Known environment caveats

- **Emulator/simulator CPU inference is extremely slow** — don't interpret long token-streaming times as a regression. The fetcher is done the moment `isReady=true`; everything after that is the model runtime.
- **Background downloads on Android will abort** in this branch — that's the WIP status the PR calls out, not a bug.
- **The harness logs only the first few entries of `listDownloadedFiles()`**; if you need the full list, check the React Native dev console.
