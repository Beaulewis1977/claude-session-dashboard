// electron-vite: `import path from './worker?modulePath'` is the built worker's file.
declare module '*?modulePath' {
  const path: string
  export default path
}
