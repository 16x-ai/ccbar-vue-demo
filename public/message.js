(function(win) {
    function createDom(className = '', tag = 'dev') {
        const ele = document.createElement(tag);
        ele.className = className;
        return ele;
    }

    function cssFromObj(obj) {
        if (typeof obj === 'object' && obj != null) {
            var cssAttr = '';
            Object.keys(obj).forEach(function(key) {
                cssAttr += key + ': ' + obj[key] + ';';
            })

            return cssAttr;
        }

        return '';
    }

    var commonCss = {
        'display': 'inline-block',
        'background-color': '#ebeef5',
        'border': '1px solid #ebeef5',
        'border-radius': '4px',
        'padding': '15px 15px 15px 20px',
        'overflow': 'hidden',
        'text-overflow': 'hidden',
        'color': '#fff',
        'font-size': '14px',
        'z-index':'1000',
        'box-shadow': '0 3px 6px -4px #0000001f, 0 6px 16px #00000014, 0 9px 28px 8px #0000000d'
    }

    var errorCss = {
        'color': 'red',
    }

    var succCss = {
        'color': 'green',
    }

    var warnCss = {
        'color': '#e6c23a',
    }

    var infoCss = {
        'color': 'bule',
    }

    class Message {
        constructor (text, config, cssConfig = {}) {
            this.config = {
                type: 'info',
                text: text || '提示',
                position: 'top',
                distance: '30px',
                duration: 2000,
                delay: 0,
                closable: true,
                icon: ''
            }

            this.init(config, cssConfig);
        }

        getCss(type) {
            if (type == 'error') {
                return errorCss;
            }

            if (type == 'succ') {
                return succCss
            }

            if (type == 'warnCss') {
                return warnCss
            }

            if (type == 'info') {
                return infoCss
            }
        }

        init (config, cssConfig) {
            this.id = 'message-' + Date.now();
            this.cssConfig = cssConfig;
            Object.assign(this.config, config);

            var cssObj = Object.assign(commonCss, this.getCss(this.config.type), cssConfig);

            var box = createDom('hxl-message', 'dev');
            box.style = 'position: fixed; width: 100%; text-align: center; top: 30px;';
            box.id = this.id;

            var ibox = createDom('hxl-message1', 'dev');
            ibox.style = cssFromObj(cssObj)

            box.appendChild(ibox)

            var text = createDom('hxl-message-text', 'span');
            text.innerHTML = this.config.text;
            text.style = 'flex: 1;'
            ibox.appendChild(text);

            this.box = box;
        }

        show () {
            var that =this;
            document.body.appendChild(this.box);
            this.timeout = setTimeout(function() {
                that.hide();
                clearTimeout(that.timeout);
            }, this.config.duration);
        }

        hide () {
            var box = document.querySelector('#' + this.id);
            box && typeof box.remove === 'function' && box.remove();
            clearTimeout(this.timeout);
        }

        static handleShow(text, type) {
            var a = new Message(text, {type: type});
            a.show();
        }

        static error (text) {
            Message.handleShow(text, 'error')
        }

        static succ (text) {
            Message.handleShow(text, 'succ')
        }

        static info (text) {
            Message.handleShow(text, 'info')
        }

        static warn (text) {
            Message.handleShow(text, 'warn')
        }
    }

    win.message = Message;
})(window)