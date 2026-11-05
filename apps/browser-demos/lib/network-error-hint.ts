type BrowserPlatform = Pick<Navigator, "platform" | "userAgent" | "maxTouchPoints"> & {
  userAgentData?: { platform: string };
};

/** Advice for failed peer links, not invalid invitations or server errors. */
export function networkErrorHint(
  error: string | null,
  browser: BrowserPlatform | undefined = typeof navigator === "undefined" ? undefined : navigator,
): string | null {
  if (!error || !/^(?:the peer connection (?:failed|closed before connecting|timed out)|peer channel .+ failed$|the (?:hosting|joining) computer did not connect$)/i.test(error)) {
    return null;
  }

  const platform = browser?.userAgentData?.platform || browser?.platform || browser?.userAgent || "";
  // iPadOS can identify as MacIntel; do not send it to macOS System Settings.
  const mobile = /iPhone|iPad|iPod|Android/i.test(browser?.userAgent ?? "")
    || (/Mac/i.test(platform) && (browser?.maxTouchPoints ?? 0) > 1);
  if (!mobile && /Mac/i.test(platform)) {
    return "On macOS, check System Settings → Privacy & Security → Local Network for your browser. After changes, reopen it and retry; check the other peer’s permissions too.";
  }
  if (!mobile && /Win/i.test(platform)) {
    return "On Windows, check your browser under Windows Security → Firewall & network protection → Allow an app through firewall. Check the other peer too, then retry.";
  }
  return "Check both browsers’ local-network permissions and whether a VPN or firewall blocks peer connections, then retry.";
}
