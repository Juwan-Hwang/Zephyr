// ===========================================================================
// os_notification_tests.rs — Golden (snapshot) tests for notification utils
// ===========================================================================
//
// Tests `truncate_str` which truncates strings to a max character count,
// appending "..." when truncation occurs (or a partial "..." for max_len < 3).
//
// This file is included from os_notification.rs via:
//   #[cfg(test)]
//   #[path = "os_notification_tests.rs"]
//   mod os_notification_tests;

#[allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod tests {
    use super::super::truncate_str;

    #[test]
    fn no_truncation_needed() {
        insta::assert_snapshot!(truncate_str("Hello", 10));
    }

    #[test]
    fn exact_length() {
        insta::assert_snapshot!(truncate_str("Hello", 5));
    }

    #[test]
    fn truncate_short() {
        insta::assert_snapshot!(truncate_str("Hello World", 8));
    }

    #[test]
    fn truncate_unicode() {
        insta::assert_snapshot!(truncate_str("你好世界Hello", 6));
    }

    #[test]
    fn truncate_to_zero() {
        insta::assert_snapshot!(truncate_str("Hello", 0));
    }

    #[test]
    fn truncate_to_one() {
        insta::assert_snapshot!(truncate_str("Hello", 1));
    }

    #[test]
    fn truncate_to_two() {
        insta::assert_snapshot!(truncate_str("Hello", 2));
    }

    #[test]
    fn truncate_to_three() {
        insta::assert_snapshot!(truncate_str("Hello", 3));
    }

    #[test]
    fn empty_string() {
        insta::assert_snapshot!(truncate_str("", 10));
    }

    #[test]
    fn truncate_str_never_exceeds_max_len() {
        for max in 0..10 {
            let out = truncate_str("你好世界Hello", max);
            assert!(
                out.chars().count() <= max,
                "truncate_str returned {} chars for max_len={max}",
                out.chars().count()
            );
        }
    }
}
