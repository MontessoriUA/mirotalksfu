'use strict';

/*
 * Montemeet: our About dialog + cabinet-driven conference appearance.
 *
 * About: the stock showAbout() renders BRAND.about (env-driven author/support
 * links); we replace the whole popup — Montemeet identity, montessori.ua link,
 * and only the engine copyright line stays. showAbout is a stock top-level
 * function declaration, so reassigning the global binding intercepts the
 * aboutButton click path.
 *
 * Appearance: the admin's "Оформлення конференції" card (cabinet → registry →
 * GET /profile/:roomId → MontemeetProfile.style()) is forced identically on
 * every participant AFTER roomIsReady() restored personal localStorage values
 * (the Style tab itself is hidden by MontemeetRoles).
 */

(function () {
    const mmT = (s) => (window.mmT ? window.mmT(s) : s);

    // Значок вкладки. В разметке он наш, но стоковый Brand.js перезаписывает
    // его своим (BRAND.site.icon — logo.svg MiroTalk), и в браузере оставался
    // прежний (Иван, 24.11). Brand.js подключён раньше нас, поэтому просто
    // ставим своё обратно — стоковый файл не трогаем, чтобы не ловить
    // конфликты при ребейзе на апстрим.
    try {
        if (window.BRAND?.site) {
            BRAND.site.icon = '../images/montemeet-mark.svg';
            BRAND.site.appleTouchIcon = '../images/montemeet-og.png';
        }
        const icon = document.getElementById('icon');
        if (icon) icon.href = '../images/montemeet-mark.svg';
        const apple = document.getElementById('appleTouchIcon');
        if (apple) apple.href = '../images/montemeet-og.png';
    } catch (e) {
        console.warn('MontemeetBrand: значок вкладки не поставился', e);
    }

    window.showAbout = function () {
        if (typeof sound === 'function') sound('open');
        Swal.fire({
            background: typeof swalBackground !== 'undefined' ? swalBackground : undefined,
            position: 'center',
            // 24.11: знак-арки вместо прежнего (две фигурки) — айдентика
            // мобильной версии
            imageUrl: '../images/montemeet-mark.svg',
            imageWidth: 104,
            imageHeight: 104,
            title: 'Montessori Meet',
            html:
                '<div style="text-align:center;line-height:1.7;">' +
                mmT('Онлайн-уроки и концерты') +
                '<br /><a href="https://montessori.ua" target="_blank" rel="noopener" style="color:#1da34a;font-weight:600;">montessori.ua</a>' +
                '<br /><br /><hr /><span style="font-size:12px;opacity:.75;">&copy; ' +
                new Date().getFullYear() +
                ' MiroTalk SFU, all rights reserved</span><hr /></div>',
            showClass: { popup: 'animate__animated animate__fadeInDown' },
            hideClass: { popup: 'animate__animated animate__fadeOutUp' },
        });
    };

    // ---- cabinet-driven appearance ----
    let styleApplied = false;

    function applyStyle() {
        const st = typeof MontemeetProfile !== 'undefined' && MontemeetProfile.style();
        if (!st || styleApplied) return;
        try {
            if (st.customColor && /^#[0-9a-f]{6}$/i.test(st.customColor)) {
                themeCustom.color = st.customColor;
                themeCustom.keep = true;
                localStorageSettings.theme_color = st.customColor;
                localStorageSettings.theme_custom = true;
            } else if (st.theme && typeof themeMap === 'object' && st.theme in themeMap) {
                themeCustom.keep = false;
                localStorageSettings.theme = Object.keys(themeMap).indexOf(st.theme);
                localStorageSettings.theme_custom = false;
                selectTheme.selectedIndex = localStorageSettings.theme;
            }
            setTheme();

            if (st.buttonsBar) {
                // stock semantics are inverted: 'vertical' renders the bar as a
                // bottom row, 'horizontal' as a left column
                const stock = st.buttonsBar === 'left' ? 'horizontal' : 'vertical';
                BtnsBarPosition.value = stock;
                rc.changeBtnsBarPosition(stock);
                localStorageSettings.buttons_bar = BtnsBarPosition.selectedIndex;
                refreshMainButtonsToolTipPlacement();
            }
            if (st.pinPosition) {
                pinVideoPosition.value = st.pinPosition;
                localStorageSettings.pin_grid = pinVideoPosition.selectedIndex;
                if (rc.isVideoPinned) rc.toggleVideoPin(st.pinPosition);
            }
            lS.setSettings(localStorageSettings);
            styleApplied = true;
        } catch (e) {
            console.warn('MontemeetBrand: style apply failed', e);
        }
    }

    // roomIsReady() re-reads localStorage (loadSettingsFromLocalStorage) — our
    // force must land after it. The joined room always has the own Camera tile.
    document.addEventListener('DOMContentLoaded', () => {
        const poll = setInterval(() => {
            if (
                typeof rc !== 'undefined' &&
                rc &&
                rc.peer_id &&
                document.querySelector('#videoMediaContainer .Camera')
            ) {
                clearInterval(poll);
                setTimeout(applyStyle, 700);
            }
        }, 300);
        setTimeout(() => clearInterval(poll), 60000);
    });
})();
