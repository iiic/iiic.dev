/**
* [2026-11-27] GET /api/dashboard – údaje z Cloudflare pro widget „Cloudflare“ na nástěnce WordPressu (šablona
* domdocument-template). Jen s platným tokenem podepsaným WordPressem (hlavička Authorization), logika a popis odpovědi
* jsou ve functions/_lib/dashboard.js. Nastavení: functions/README.md, „Údaje pro nástěnku WordPressu“.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně.
*/

import { handleDashboardRequest } from '../_lib/dashboard.js';

export const onRequest = handleDashboardRequest;
