/**
 * Whether a user-agent identifies WebKit without another browser engine's
 * compatibility token. Chromium-based browsers also include `AppleWebKit`,
 * so that token alone would incorrectly enable WebKit-only memory handling.
 */
export function isWebKitLikeUserAgent(userAgent: string): boolean {
  return /AppleWebKit/i.test(userAgent)
    && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)/i.test(userAgent);
}

export function isWebKitLikeBrowser(): boolean {
  return isWebKitLikeUserAgent(navigator.userAgent);
}
