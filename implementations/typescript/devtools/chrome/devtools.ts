// ── DevTools page ─────────────────────────────────────────────────────────────

// What DevTools loads of the extension as it opens on a tab: the Bead panel, beside the others.

// dependencies

import { chromeOf } from './api';

// definition

chromeOf().devtools?.panels.create('Bead', '', 'panel.html');
