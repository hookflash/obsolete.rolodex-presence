
install:
	npm install

postinstall:
	if [ ! -L "lib/client/engine.io.js" ]; then ln -s ../../node_modules/engine.io-client/engine.io.js lib/client/engine.io.js; fi

.PHONY: postinstall
