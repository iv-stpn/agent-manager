import { Route, Routes } from "react-router-dom";
import GuidelineCategoriesPage from "./app/guideline-categories/page";
import GuidelinesPage from "./app/guidelines/page";
import Layout from "./app/layout";
import Home from "./app/page";
import ProjectDetailPage from "./app/projects/[id]/page";
import SessionPage from "./app/projects/[id]/sessions/[sessionId]/page";
import StatisticsPage from "./app/statistics/page";
import TechStacksPage from "./app/tech-stacks/page";

export default function App() {
	return (
		<Layout>
			<Routes>
				<Route path="/" element={<Home />} />
				<Route path="/projects/:id" element={<ProjectDetailPage />} />
				<Route path="/projects/:id/sessions/:sessionId" element={<SessionPage />} />
				<Route path="/statistics" element={<StatisticsPage />} />
				<Route path="/tech-stacks" element={<TechStacksPage />} />
				<Route path="/guidelines" element={<GuidelinesPage />} />
				<Route path="/guideline-categories" element={<GuidelineCategoriesPage />} />
			</Routes>
		</Layout>
	);
}
