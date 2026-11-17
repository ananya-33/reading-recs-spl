// Static illustration markup is kept separate from book data and recommendation logic.
const autumnDefs = `<defs>
  <linearGradient id="bronze" x1="0" y1="0" x2="1" y2=".8"><stop stop-color="#c4a06b"/><stop offset=".35" stop-color="#a86139"/><stop offset=".62" stop-color="#c7894b"/><stop offset="1" stop-color="#75432e"/></linearGradient>
  <filter id="pigment"><feTurbulence type="fractalNoise" baseFrequency=".65" numOctaves="3" seed="8" result="grain"/><feDisplacementMap in="SourceGraphic" in2="grain" scale=".45" xChannelSelector="R" yChannelSelector="G"/></filter>
</defs>`;
const leaf = `<g filter="url(#pigment)">
  <path d="M49 13l4 9 4-3 1 10 5-4-1 11 11-6-1 7 8-2-5 10 6 3-12 7 4 6-14 3-3 12-8-4-9 5-1-11-12-1 5-7-12-6 8-6-7-7 9 1-3-10 11 6-1-10 5 3z" fill="url(#bronze)" stroke="#825634" stroke-width=".45"/>
  <g fill="none" stroke="#e5b878" stroke-width=".5" opacity=".85"><path d="M46 81l5-57M48 67L34 54M49 59l17-12M50 47L39 35M49 55l-14-9M49 65l15-6M51 39l6-10"/><path d="M40 60l-6-1M38 57l-4-6M58 53l5-1M61 51l2-5M44 41l-5-1M44 40l-1-5M55 62l7 1M45 51l-6 1" stroke-width=".25"/></g>
  <path d="M47 72q-1 12-5 16" stroke="#775536" stroke-width=".85" fill="none"/><path d="M32 44l4 1M64 38l3-2M58 68l-1 3" stroke="#6d492b" stroke-width=".65" opacity=".6"/>
</g>`;
const autumn = `<svg class="autumn-illustration" viewBox="-20 -10 140 135">${autumnDefs}${['first', 'second', 'third', 'fourth'].map((name, index) => {
  const scale = .62 - index * .03;
  return `<g class="wind-leaf ${name}"><g transform="translate(${50 - 50 * scale} ${55 - 50 * scale}) scale(${scale})">${leaf}</g></g>`;
}).join('')}</svg>`;
const crystalArm = `<path d="M50 50V17M50 23l-3-3v-4l3-3 3 3v4zM50 29l-7-7-3 1 1 4 9 10 9-10 1-4-3-1-7 7M50 37l-11-8-4 2 3 4 12 7 12-7 3-4-4-2-11 8" fill="none" stroke="url(#ice)" stroke-width=".65"/><path d="M50 46l-4-5 4-6 4 6z" fill="#cadbd7" fill-opacity=".7" stroke="#99b0b0" stroke-width=".35"/>`;
const winter = `<svg viewBox="0 -5 100 120">
  <defs><linearGradient id="ice" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#a6b9b9"/><stop offset=".32" stop-color="#e4ece8"/><stop offset=".56" stop-color="#809b9e"/><stop offset="1" stop-color="#c3d3d0"/></linearGradient></defs>
  <g class="snow">${Array.from({ length: 6 }, (_, index) => `<g transform="rotate(${index * 60} 50 50)">${crystalArm}</g>`).join('')}<path d="M50 44l5.2 3v6L50 56l-5.2-3v-6z" fill="#d6e2dd" stroke="#8fa9a9" stroke-width=".5"/><path d="M48 47l2-1 2 1" stroke="#fffdf3" stroke-width=".65" fill="none"/></g>
</svg>`;
const summer = `<svg class="summer-vector" viewBox="0 0 160 135">
  <defs>
    <linearGradient id="shore-sand" x1="0" y1="0" x2=".3" y2="1"><stop stop-color="#cbb287"/><stop offset="1" stop-color="#ead6ad"/></linearGradient>
    <linearGradient id="shore-sea" x1="0" y1="0" x2=".2" y2="1"><stop stop-color="#38666d"/><stop offset=".6" stop-color="#609b9d"/><stop offset="1" stop-color="#b6d2c3"/></linearGradient>
    <linearGradient id="shore-deep" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#315d65" stop-opacity=".6"/><stop offset="1" stop-color="#477d83" stop-opacity=".15"/></linearGradient>
    <filter id="shore-foam-texture" x="-10%" y="-50%" width="120%" height="200%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency=".26 .7" numOctaves="2" seed="12" result="grain"/>
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 6 -2.6" result="bubbles"/>
      <feComposite in="bubbles" in2="SourceGraphic" operator="in" result="foam"/>
      <feDisplacementMap in="foam" in2="grain" scale="1.8" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <radialGradient id="shore-edge"><stop offset=".63" stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient>
    <mask id="shore-mask"><ellipse cx="80" cy="83" rx="79" ry="46" fill="url(#shore-edge)"/></mask>
  </defs>
  <g mask="url(#shore-mask)">
    <path d="M-5 41H165V135H-5Z" fill="url(#shore-sand)"/>
    <path class="shore-wet" d="M-5 41H165V77C141 70 123 90 99 84C76 78 64 96 40 90C23 86 8 97-5 94Z" transform="translate(0 6)" fill="#b09f7d" opacity=".45"/>
    <path class="shore-water" d="M-5 41H165V77C141 70 123 90 99 84C76 78 64 96 40 90C23 86 8 97-5 94Z" fill="url(#shore-sea)"/>
    <path class="shore-backwash" d="M-5 41H165V62C141 56 123 74 99 68C76 62 64 80 40 74C23 70 8 81-5 78Z" fill="url(#shore-deep)"/>
    <g fill="none" stroke="#faf7e9" stroke-linecap="round" filter="url(#shore-foam-texture)">
      <path class="shore-foam" d="M165 77C141 70 123 90 99 84C76 78 64 96 40 90C23 86 8 97-5 94" stroke-width="3.6"/>
      <path class="shore-foam" d="M165 77C141 70 123 90 99 84C76 78 64 96 40 90C23 86 8 97-5 94" transform="translate(0 -2.8)" stroke-width="2.2" stroke-dasharray="4 1.8 .7 2.4 2.6 1.2" opacity=".65"/>
      <path class="shore-foam" d="M165 77C141 70 123 90 99 84C76 78 64 96 40 90C23 86 8 97-5 94" transform="translate(0 -5)" stroke-width="1" stroke-dasharray=".5 3 1.8 4 .6 2.3" opacity=".4"/>
    </g>
  </g>
</svg>`;

export const seasons = {
  autumn: { heading: 'autumn leaves falling down like pieces into place', color: '#a55b38', loading: 'Loading book recs to read at your local cafe...', art: autumn },
  winter: { heading: 'winter is hopeful', color: '#627b89', loading: 'Finding you some good books to curl up with on the couch...', art: winter },
  spring: { heading: 'here comes the sun', color: '#98716e', loading: 'Finding books to read at the park while cute dogs pass by...', art: '<img class="spring-art" src="assets/spring-preview.png" alt="">' },
  summer: { heading: "no ray of sunlight's ever lost", color: '#a88742', loading: 'Finding your next beach read...', art: summer }
};
