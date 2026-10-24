import { createContext, useContext } from 'react'

/** Runs an action; if the server answers 423 (password confirmation required) the user is asked for their password and the action is retried once. */
export type SensitiveRunner = <T>(action: () => Promise<T>) => Promise<T>

export const SensitiveContext = createContext<SensitiveRunner>(action => action())

export function useSensitiveAction() { return useContext(SensitiveContext) }
