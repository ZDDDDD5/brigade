// A person's picture as the API gives it (`image`): the one they chose in Settings › Profile, a
// path under /api, or their sign-in's (Google's), a URL of its own.
import { API_URL } from './config'

/** Where the browser loads a person's picture from; null when they have none. */
export const userImageSrc = (image: string | null | undefined) =>
  !image ? null : image.startsWith('/') ? `${API_URL}/api${image}` : image

/** The picture is one they chose in Settings › Profile (it can be removed there). */
export const chosenImage = (image: string | null | undefined) => !!image?.startsWith('/users/')
