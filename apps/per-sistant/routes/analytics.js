const express = require("express");

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/analytics", async (req, res) => {
    try {
      const { period } = req.query; // "week", "month", "quarter", "year"
      const now = new Date();
      let startDate;
      if (period === "year") { startDate = new Date(now.getFullYear(), 0, 1); }
      else if (period === "quarter") { startDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1); }
      else if (period === "month") { startDate = new Date(now.getFullYear(), now.getMonth(), 1); }
      else { // default week
        startDate = new Date(now);
        const dayOfWeek = now.getDay();
        startDate.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      }
      startDate.setHours(0,0,0,0);
      const sd = startDate.toISOString().split("T")[0];
      const ed = now.toISOString().split("T")[0];

      // Heatmap date: 90 days ago
      const heatmapStart = new Date(now);
      heatmapStart.setDate(heatmapStart.getDate() - 90);
      const hsd = heatmapStart.toISOString().split("T")[0];

      const [completedByDay, createdByDay, completionRate, priorityBreakdown, categoryBreakdown, avgCompletionTime, streakLeaders, productivityByDow, heatmapData, emailsSent, notesMade] = await Promise.all([
        pool.query(`SELECT DATE(completed_at) as day, COUNT(*) as count FROM todos WHERE deleted_at IS NULL AND completed = true AND completed_at >= $1 GROUP BY DATE(completed_at) ORDER BY day`, [sd]),
        pool.query(`SELECT DATE(created_at) as day, COUNT(*) as count FROM todos WHERE deleted_at IS NULL AND created_at >= $1 GROUP BY DATE(created_at) ORDER BY day`, [sd]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE completed) as done, COUNT(*) as total FROM todos WHERE deleted_at IS NULL AND created_at >= $1`, [sd]),
        pool.query(`SELECT priority, COUNT(*) as count FROM todos WHERE deleted_at IS NULL AND completed = false GROUP BY priority ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`),
        pool.query(`SELECT COALESCE(category, 'uncategorized') as category, COUNT(*) as count, COUNT(*) FILTER (WHERE completed) as completed FROM todos WHERE deleted_at IS NULL AND created_at >= $1 GROUP BY category ORDER BY count DESC`, [sd]),
        pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600) as avg_hours FROM todos WHERE deleted_at IS NULL AND completed = true AND completed_at >= $1`, [sd]),
        pool.query(`SELECT title, streak_count, best_streak, recurrence_rule FROM todos WHERE deleted_at IS NULL AND recurring = true AND completed = false AND streak_count > 0 ORDER BY streak_count DESC LIMIT 5`),
        pool.query(`SELECT EXTRACT(DOW FROM completed_at) as dow, COUNT(*) as count FROM todos WHERE deleted_at IS NULL AND completed = true AND completed_at >= $1 GROUP BY dow ORDER BY dow`, [sd]),
        // Heatmap: completions per day for last 90 days
        pool.query(`SELECT DATE(completed_at) as day, COUNT(*) as count FROM todos WHERE deleted_at IS NULL AND completed = true AND completed_at >= $1 GROUP BY DATE(completed_at) ORDER BY day`, [hsd]),
        // Emails sent in period
        pool.query(`SELECT COUNT(*) as count FROM emails WHERE deleted_at IS NULL AND sent_at >= $1`, [sd]),
        // Notes created in period
        pool.query(`SELECT COUNT(*) as count FROM notes WHERE deleted_at IS NULL AND created_at >= $1`, [sd]),
      ]);

      const rate = completionRate.rows[0];
      const totalCompleted = parseInt(rate.done);
      const totalCreated = parseInt(rate.total);
      const completionPct = totalCreated > 0 ? Math.round((totalCompleted / totalCreated) * 100) : 0;
      const avgHours = avgCompletionTime.rows[0]?.avg_hours ? Math.round(avgCompletionTime.rows[0].avg_hours * 10) / 10 : null;
      const topStreak = streakLeaders.rows[0]?.streak_count || 0;
      // Productivity score: weighted composite (completion rate 40%, streak bonus 20%, volume 20%, speed 20%)
      const volumeScore = Math.min(totalCompleted / 10, 1) * 100; // 10 tasks = max
      const speedScore = avgHours ? Math.max(0, Math.min(100, 100 - avgHours)) : 50;
      const streakScore = Math.min(topStreak / 7, 1) * 100;
      const productivityScore = Math.round(completionPct * 0.4 + streakScore * 0.2 + volumeScore * 0.2 + speedScore * 0.2);

      res.json({
        period: period || "week",
        start_date: sd,
        end_date: ed,
        completed_by_day: completedByDay.rows,
        created_by_day: createdByDay.rows,
        completion_rate: completionPct,
        total_completed: totalCompleted,
        total_created: totalCreated,
        priority_breakdown: priorityBreakdown.rows,
        category_breakdown: categoryBreakdown.rows,
        avg_completion_hours: avgHours,
        streak_leaders: streakLeaders.rows,
        productivity_by_dow: productivityByDow.rows,
        heatmap: heatmapData.rows,
        productivity_score: productivityScore,
        emails_sent: parseInt(emailsSent.rows[0]?.count || 0),
        notes_created: parseInt(notesMade.rows[0]?.count || 0),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
