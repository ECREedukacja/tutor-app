import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Domyślny limit body Server Actions to 1 MB — przy większych plikach
    // FormData dochodziło obcięte (file.size === 0), stąd mylący komunikat
    // „Plik jest pusty”. Limit 12 MB pozwala bezpiecznie wysłać plik 10 MB
    // razem z narzutem FormData + sąsiednimi polami.
    serverActions: {
      bodySizeLimit: '12mb',
    },
  },
};

export default nextConfig;
