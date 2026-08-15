CREATE TABLE `job_resumes` (
	`job_id` text PRIMARY KEY NOT NULL,
	`resumed_from_job_id` text NOT NULL,
	`resumed_from_node` text NOT NULL,
	`created_at` integer NOT NULL
);
