// The rules for a computer name in Delo. A name is kebab-case: lowercase
// letters and digits in words joined by single hyphens, because every delo
// verb takes the name as one word. Two computers never share a name,
// compared without case. Kandelo's generator writes three capitalized words
// with spaces; Delo writes the same words in kebab-case, and shows and finds
// a computer the Kandelo app named by the kebab-case form of its title,
// without writing it back.

import { randomComputerName } from "../../../../../web-libs/kandelo-session/src/computer-name";

export const MAX_NAME_LENGTH = 120;

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Why `name` cannot name a computer next to `others`, or null when it can. */
export function deloNameProblem(name: string, others: readonly string[]): string | null {
  if (name === "" || name.length > MAX_NAME_LENGTH) return `Computer names must contain 1–${MAX_NAME_LENGTH} characters`;
  if (!KEBAB_CASE.test(name)) return "a computer name is kebab-case: lowercase letters and digits, joined by single hyphens, such as brave-cookie-otter";
  if (others.some((other) => other.toLowerCase() === name.toLowerCase())) return `a computer is already named ${name}`;
  return null;
}

/** A free random name next to `others`, such as brave-cookie-otter. */
export function deloRandomName(others: readonly string[]): string {
  return randomComputerName(others.map((other) => other.replaceAll("-", " "))).toLowerCase().replaceAll(" ", "-");
}

/** The name Delo shows and finds a computer by: its title in kebab-case, such as dancing-hazelnut-raccoon for Dancing Hazelnut Raccoon. */
export function deloComputerName(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
