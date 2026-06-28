import { Route, Routes } from "react-router-dom";
import Layout from "./app/layout";
import Home from "./app/page";
import ProjectDetailPage from "./app/projects/[id]/page";
import SessionPage from "./app/projects/[id]/sessions/[sessionId]/page";
import StatisticsPage from "./app/statistics/page";
import TemplatesPage from "./app/templates/page";

export default function App() {
	return (
		<Layout>
			<Routes>
				<Route path="/" element={<Home />} />
				<Route path="/projects/:id" element={<ProjectDetailPage />} />
				<Route path="/projects/:id/sessions/:sessionId" element={<SessionPage />} />
				<Route path="/statistics" element={<StatisticsPage />} />
				<Route path="/templates" element={<TemplatesPage />} />
			</Routes>
		</Layout>
	);
}
