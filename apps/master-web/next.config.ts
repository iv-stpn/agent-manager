/** @type {import('next').NextConfig} */
const nextConfig = {
	output: "standalone",
	env: {
		NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3100",
	},
	async rewrites() {
		const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3100";
		return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
	},
};

export default nextConfig;
