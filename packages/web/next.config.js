/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  transpilePackages: ["@vipcam/shared"],
};

export default nextConfig;
