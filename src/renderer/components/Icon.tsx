const paths = {
  link: 'm10 7 3-3a5 5 0 0 1 7 7l-3 3M14 17l-3 3a5 5 0 0 1-7-7l3-3m1 8 8-8',
  chevron: 'm9 5 7 7-7 7',
  clock: 'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  retry: 'M4 10a8 8 0 1 1 1 8M4 4v6h6',
  file: 'M5 3h9l5 5v13H5Zm9 0v5h5M8 13h8m-8 4h5',
  download: 'M12 3v12m-5-5 5 5 5-5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
  folder: 'M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  video: 'M4 4h16v16H4ZM9 8l7 4-7 4Z',
  audio: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3c1.6 0 3 1.3 3 3Zm11-2a3 3 0 1 1-3-3c1.6 0 3 1.3 3 3Z',
  check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M6 18 18 6', arrow: 'M4 12h16m-6-6 6 6-6 6',
  layers: 'm12 3 10 5-10 5L2 8Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  info: 'M12 8v.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z'
};
export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
