import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

// Intermediate redirect page for Apple Music URLs.
// Navigating here from a click handler (same-origin, no Universal Links),
// then redirecting to music.apple.com from useEffect (out of gesture context)
// prevents iOS from triggering Universal Links → web player opens instead of native app.
export default function AppleMusicRedirect() {
  const [searchParams] = useSearchParams();
  const url = searchParams.get('url');

  useEffect(() => {
    if (url) {
      window.location.href = url;
    }
  }, [url]);

  return null;
}
