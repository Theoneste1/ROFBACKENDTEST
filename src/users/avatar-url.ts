/** The profile's avatarUrl for a stored picture: an authenticated API path, versioned by the file id (no import cycle). */
export const avatarUrlOf = (userId: string, fileId: string) => `/api/v1/users/${userId}/avatar?v=${fileId}`;
