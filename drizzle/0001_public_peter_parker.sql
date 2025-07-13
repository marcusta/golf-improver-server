PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`test_id` text NOT NULL,
	`test_name` text NOT NULL,
	`date` integer NOT NULL,
	`total_putts` integer NOT NULL,
	`holes_completed` integer NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_id`) REFERENCES `test_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_rounds`("id", "user_id", "test_id", "test_name", "date", "total_putts", "holes_completed", "created_at", "completed_at") SELECT "id", "user_id", "test_id", "test_name", "date", "total_putts", "holes_completed", "created_at", "completed_at" FROM `rounds`;--> statement-breakpoint
DROP TABLE `rounds`;--> statement-breakpoint
ALTER TABLE `__new_rounds` RENAME TO `rounds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_test_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`hole_count` integer NOT NULL,
	`distances` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_test_templates`("id", "name", "description", "hole_count", "distances", "created_at") SELECT "id", "name", "description", "hole_count", "distances", "created_at" FROM `test_templates`;--> statement-breakpoint
DROP TABLE `test_templates`;--> statement-breakpoint
ALTER TABLE `__new_test_templates` RENAME TO `test_templates`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "first_name", "last_name", "email", "password_hash", "last_login_at", "created_at") SELECT "id", "first_name", "last_name", "email", "password_hash", "last_login_at", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);