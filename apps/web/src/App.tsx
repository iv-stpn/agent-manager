import { Route, Routes } from "react-router-dom";
import GuidelineCategoriesPage from "./app/guideline-categories/GuidelineCategoriesPage";
import GuidelinesPage from "./app/guidelines/GuidelinesPage";
import HomePage from "./app/HomePage";
import Layout from "./app/layout";
import LlmClientsPage from "./app/llm-clients/LlmClientsPage";
import ProjectDetailPage from "./app/projects/[id]/ProjectDetailPage";
import SessionPage from "./app/projects/[id]/sessions/[sessionId]/SessionPage";
import StatisticsPage from "./app/statistics/StatisticsPage";
import TechStacksPage from "./app/tech-stacks/TechStacksPage";

export default function App() {
	return (
		<Layout>
			<Routes>
				<Route path="/" element={<HomePage />} />
				<Route path="/projects/:id" element={<ProjectDetailPage />} />
				<Route path="/projects/:id/sessions/:sessionId" element={<SessionPage />} />
				<Route path="/statistics" element={<StatisticsPage />} />
				<Route path="/llm-clients" element={<LlmClientsPage />} />
				<Route path="/tech-stacks" element={<TechStacksPage />} />
				<Route path="/guidelines" element={<GuidelinesPage />} />
				<Route path="/guideline-categories" element={<GuidelineCategoriesPage />} />
			</Routes>
		</Layout>
	);
}
