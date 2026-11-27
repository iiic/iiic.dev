/**
* [2026-11-27] GET /api/dashboard/github – provoz repozitáře statického webu na GitHubu (zobrazení, klonování, odkazující
* weby, nejnavštěvovanější stránky repozitáře) pro stránku Analytická data ve WordPressu (šablona domdocument-template).
* Jen s platným tokenem podepsaným WordPressem (hlavička Authorization), logika a popis odpovědi jsou
* ve functions/_lib/dashboard-github.js. Nastavení: functions/README.md, „Údaje pro nástěnku WordPressu“.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně.
*/

import { handleGithubRequest } from '../../_lib/dashboard-github.js';

export const onRequest = handleGithubRequest;
