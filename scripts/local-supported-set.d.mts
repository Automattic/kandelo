/** The planner owns schema validation; JavaScript consumers read a valid set. */
export function readLocalSupportedSet(text: string): {
  builtPackages: Set<string>;
  activeProducts: Set<string>;
};
