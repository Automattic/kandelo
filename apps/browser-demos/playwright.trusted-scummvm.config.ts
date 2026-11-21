import { defineConfig } from './playwright-test';
import cage from './playwright.trusted-cage.config';

// Explicit networked game check; the ordinary Cage/Freeciv inventory is separate.
export default defineConfig({ ...cage, testMatch: ['trusted-scummvm.check.ts'] });
