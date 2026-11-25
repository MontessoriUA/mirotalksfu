'use strict';

// Montemeet: возврат на страницу урока.
//
// Заход 24.11 (Иван): «после окончания встречи выбрасывает на страницу сайта;
// возвращаюсь кнопкой „назад“ — страница урока как бы загружается, но
// разрешение на микрофон не спрашивается и просто висит прелоадер».
//
// Здесь две страховки, обе дешёвые.
//
// 1. Страница, восстановленная из кэша «назад» (bfcache). Тогда разметка и
//    переменные те же, что были при уходе, но соединения мертвы, а повторного
//    запроса микрофона не будет: код инициализации уже отработал в прошлой
//    жизни страницы. Единственное верное лечение — перезагрузить её. Замер на
//    стенде показал, что наша страница в bfcache обычно НЕ попадает (живой
//    WebRTC это запрещает), но поведение зависит от браузера, а Safari кэширует
//    охотнее прочих, поэтому страховка нужна.
//
// 2. Страница загрузилась заново, но вход так и не случился. Тогда человек
//    видит бесконечный прелоадер и не знает, что делать. Через 20 секунд
//    показываем одну строку и кнопку (текст Ивана, 24.11). Это не лечит
//    причину, но превращает «всё висит» в понятное действие.
//
// Ничего не делает, пока всё идёт нормально.

(function () {
    const RETRY_AFTER_MS = 20000;

    // восстановление из кэша «назад»: поднимаем страницу заново
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        console.log('[Montemeet] страница вернулась из кэша «назад» — перезагружаю');
        location.reload();
    });

    // вход не случился за разумное время
    function watchStuck() {
        if (!/^\/join\//.test(location.pathname)) return;

        setTimeout(() => {
            // Судим по тому, что человек видит, а не по внутренним признакам:
            // прелоадер пропал — значит страница ожила, и мы молчим. Прежний
            // критерий смотрел на сокет, а он подключается и при зависшем
            // входе, поэтому у Ивана 24.11 подсказка так и не появилась.
            // Судим ТОЛЬКО по прелоадеру. Признак «вошёл» тут не помощник:
            // клиент выставляет его сразу после отправки запроса на вход, не
            // дожидаясь ответа (join() не возвращает свою цепочку), и через
            // один сетевой круг он уже true — подсказка молчала даже при
            // зависшем входе (разбор 25.11). Прелоадер прячется на успешном
            // входе, так что ложных подсказок не будет.
            const loader = document.getElementById('loadingDiv');
            const stillLoading = loader && loader.getBoundingClientRect().width > 0;
            if (!stillLoading) return;
            if (document.getElementById('mmStuck')) return;

            const box = document.createElement('div');
            box.id = 'mmStuck';
            box.style.cssText =
                'position:fixed;z-index:2147483200;left:50%;top:50%;transform:translate(-50%,-50%);' +
                'max-width:min(420px,calc(100vw - 32px));padding:20px 22px;border-radius:16px;' +
                'background:rgba(24,24,29,.95);color:#eceef2;border:1px solid rgba(255,255,255,.18);' +
                'box-shadow:0 12px 40px rgba(0,0,0,.5);font:15px/1.5 system-ui,-apple-system,sans-serif;text-align:center';
            const say = (t) => (typeof window.mmT === 'function' ? window.mmT(t) : t);
            box.innerHTML =
                `<div>${say('Данные для входа устарели. Перезагрузите страницу')}</div>` +
                '<button id="mmStuckBtn" style="margin-top:16px;background:#2f6df6;color:#fff;border:0;' +
                `border-radius:10px;padding:10px 18px;font:inherit;cursor:pointer">${say('Обновить страницу')}</button>`;
            document.body.appendChild(box);
            box.querySelector('#mmStuckBtn').onclick = () => location.reload();
        }, RETRY_AFTER_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watchStuck);
    } else {
        watchStuck();
    }
})();
