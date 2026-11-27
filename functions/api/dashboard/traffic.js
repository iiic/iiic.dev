/**
* [2026-11-27] GET /api/dashboard/traffic – HTTP provoz zóny (požadavky, přenesená data, podíl z cache, zablokované hrozby)
* pro widget „Cloudflare – provoz zóny“ na nástěnce WordPressu (šablona domdocument-template). Jen s platným tokenem
* podepsaným WordPressem (hlavička Authorization), logika a popis odpovědi jsou ve functions/_lib/dashboard-traffic.js.
* Nastavení: functions/README.md, „Údaje pro nástěnku WordPressu“.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně.
*/

import { handleTrafficRequest } from '../../_lib/dashboard-traffic.js';

export const onRequest = handleTrafficRequest;
