// Debug logging — stripped in production builds
const DEV = process.env.NODE_ENV === "development"

export const log = DEV ? console.log.bind(console) : () => {}
export const warn = DEV ? console.warn.bind(console) : () => {}
export const err = console.error.bind(console) // errors always logged
