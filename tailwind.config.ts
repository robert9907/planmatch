import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        lora: ['Lora', 'serif'],
        sans: ['"Source Sans 3"', 'system-ui', 'sans-serif'],
      },
      colors: {
        sage: 'var(--sage)',
        sl: 'var(--sl)',
        sm: 'var(--sm)',
        warm: 'var(--warm)',
        wh: 'var(--wh)',
        w2: 'var(--w2)',
        w3: 'var(--w3)',
        ink: 'var(--ink)',
        i2: 'var(--i2)',
        i3: 'var(--i3)',
        blue: 'var(--blue)',
        bt: 'var(--bt)',
        amb: 'var(--amb)',
        at: 'var(--at)',
        red: 'var(--red)',
        rt: 'var(--rt)',
        pur: 'var(--pur)',
        pt: 'var(--pt)',
        teal: 'var(--teal)',
        tl: 'var(--tl)',
        enroll: 'var(--enroll)',
        navy: 'var(--navy)',
        nvlt: 'var(--nvlt)',
        nvbd: 'var(--nvbd)',
      },
    },
  },
  plugins: [],
};

export default config;
