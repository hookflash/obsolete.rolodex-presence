*Status: DEV*

Rolodex presence plugin
=======================

This rolodex plugin provides:

  * Realtime presence (online/offline) events for contacts via persistent websocket connection.
  * A messaging channel between contacts.


Usage
-----

Install:

    npm install openpeer-rolodex-presence

Integrate:

  * Server-side - See https://github.com/openpeer/opjs-demo/blob/master/server/server.js
  * Client-side - See https://github.com/openpeer/opjs-demo/blob/master/server/ui/.rolodex/app.js


Debug
-----

    (function() { require(["rolodex-presence/client"], function (CLIENT) { CLIENT.setDebug(true, ["message", "engine.io"]); }); })()
    (function() { require(["rolodex-presence/client"], function (CLIENT) { CLIENT.setDebug(true, ["message"]); }); })()
    (function() { require(["rolodex-presence/client"], function (CLIENT) { CLIENT.setDebug(false); }); })()


License
=======

[BSD-2-Clause](http://opensource.org/licenses/BSD-2-Clause)
