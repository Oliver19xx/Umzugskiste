// Öffentliche Einstellungen. Kein Secret: Das SoundCloud-Secret liegt nur in der Token-Funktion.
// Leer heißt: SoundCloud erscheint in der App als „wird eingerichtet“.
export const CONFIG = {
  soundcloudClientId: '',
  soundcloudTokenUrl: '', // https://<projekt>.supabase.co/functions/v1/soundcloud-token
};
