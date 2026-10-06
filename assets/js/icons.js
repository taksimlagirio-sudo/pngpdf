// İndirici ikon seti: 24 px ızgara, 1,75 px çizgi, yuvarlak uç ve köşeler; renk yazı renginden
// (currentColor). Her ikon tek bir yol (`d`); `fill` olanlar dolu çizilir, `sw` çizgi kalınlığını değiştirir.
// Tasarım: "İndirici ikon seti" tuvali.
export const ICONS = {
    back: { d: 'M19 12H5M11 18l-6-6 6-6' },
    close: { d: 'M6 6l12 12M18 6L6 18' },
    plus: { d: 'M12 5v14M5 12h14' },
    minus: { d: 'M5 12h14' },
    check: { d: 'M5 12.5l4.5 4.5L19 7.5' },
    lock: { d: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z' },
    user: { d: 'M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8M4 21a8 8 0 0 1 16 0' },
    chevronRight: { d: 'M9 6l6 6-6 6' },
    chevronUp: { d: 'M6 15l6-6 6 6' },
    chevronDown: { d: 'M6 9l6 6 6-6' },
    more: { d: 'M12 5h.01M12 12h.01M12 19h.01', sw: 3 },
    grip: { d: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', sw: 3 },

    play: { d: 'M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z', fill: true },
    pause: { d: 'M7 5h3v14H7zM14 5h3v14h-3z', fill: true },
    record: { d: 'M6 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0', fill: true },
    back10: { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5' },
    fwd10: { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5' },
    loop: { d: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4' },
    volume: { d: 'M4 10v4h3l5 4V6L7 10zM16 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11' },
    mute: { d: 'M4 10v4h3l5 4V6L7 10zM16 9l5 6M21 9l-5 6' },
    music: { d: 'M9 18V5l11-2v13M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0M14 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0' },
    waveform: { d: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2' },
    subtitles: { d: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7 15h4M13 15h4M7 11h2M11 11h6' },
    pip: { d: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM13 12h5v4h-5z' },
    maximize: { d: 'M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4' },
    minimize: { d: 'M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4' },
    cast: { d: 'M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01' },
    tv: { d: 'M4.5 4.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM8 21h8' },
    globe: { d: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z' },

    download: { d: 'M12 3v12M7 10l5 5 5-5M5 21h14' },
    share: { d: 'M12 15V3M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7' },
    edit: { d: 'M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16zM13.5 6.5l4 4' },
    trash: { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3' },
    link: { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
    paste: { d: 'M9 3h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2' },
    history: { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l3 2' },
    broadcast: { d: 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8.5 8.5a5 5 0 0 0 0 7M15.5 15.5a5 5 0 0 0 0-7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 18.4a9 9 0 0 0 0-12.8' },
    touch: { d: 'M22 14a8 8 0 0 1-8 8M18 11v-1a2 2 0 0 0-4 0M14 10V9a2 2 0 0 0-4 0v1M10 9.5V4a2 2 0 0 0-4 0v10M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' },
    info: { d: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 11v5M12 8h.01' },
    alert: { d: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 8v5M12 16h.01' },
    sync: { d: 'M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5' },
    refresh: { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5' },

    camera: { d: 'M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 13a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0' },
    image: { d: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 16l4.5-4.5a1.5 1.5 0 0 1 2 0L16 17M14 14l1.5-1.5a1.5 1.5 0 0 1 2 0L20 15M14.5 8.5h.01' },
    film: { d: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4' },
    scissors: { d: 'M3 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12' },
    rotate: { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5' },
    flip: { d: 'M12 3v18M8 7L3 12l5 5zM16 7l5 5-5 5z' },
    compare: { d: 'M8 7l-5 5 5 5M16 7l5 5-5 5M3 12h18' },
    merge: { d: 'M8 6H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M16 6h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M9 12h6M12 9l3 3-3 3' },

    grid: { d: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
    wall: { d: 'M4 4h7v10H4zM13 4h7v6h-7zM4 16h7v4H4zM13 12h7v8h-7z' },
    list: { d: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' },
    folder: { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
    laptop: { d: 'M5 5h14a1 1 0 0 1 1 1v9H4V6a1 1 0 0 1 1-1zM2 19h20' },
    server: { d: 'M5 4h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM5 14h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM8 7h.01M8 17h.01' },
    sun: { d: 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' },
    moon: { d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z' }
};

/** Satır içi SVG ikon (yazının rengini ve boyutunu alır: 1em; `size` ile px verilebilir). */
export function icon(name, { size = 0, cls = '' } = {}) {
    const ic = ICONS[name];
    if (!ic) return '';
    const dim = size ? ` width="${size}" height="${size}"` : '';
    return `<svg class="ic${cls ? ' ' + cls : ''}"${dim} viewBox="0 0 24 24" aria-hidden="true" focusable="false"`
        + ` fill="${ic.fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${ic.sw || 1.75}"`
        + ` stroke-linecap="round" stroke-linejoin="round"><path d="${ic.d}"/></svg>`;
}
