use super::*;
use crate::testing::SteppingClock;

const GRACE: Duration = Duration::from_secs(5);

fn budget_of(clock: &Arc<SteppingClock>, budget: u64) -> Arc<MessageBudget> {
    MessageBudget::new(MessageBounds {
        message_bytes_budget: budget,
        minimum_body_bytes_per_second: 240,
        body_grace_period: GRACE,
        clock: Arc::<SteppingClock>::clone(clock),
    })
}

fn clock() -> Arc<SteppingClock> {
    SteppingClock::new(std::time::SystemTime::UNIX_EPOCH)
}

// a holding whose message began and was charged `bytes`
fn holding_of(budget: &Arc<MessageBudget>, bytes: u64) -> Holding {
    let mut holding = budget.holding();

    holding.begin();
    assert!(holding.charge(bytes), "{bytes} charged");

    holding
}

#[tokio::test]
async fn casts_off_the_holders_that_hold_the_most_until_a_charge_fits_the_asking_one_only_when_it_holds_the_most()
 {
    let clock = clock();
    let budget = budget_of(&clock, 500);
    let ada = holding_of(&budget, 194);
    let bob = holding_of(&budget, 146);
    let mut carol = budget.holding();

    carol.begin();

    assert!(carol.charge(174), "carol's charge taken, ada cast off");
    assert!(ada.is_cast_off(), "ada, who held the most");
    assert!(!bob.is_cast_off(), "bob kept");
    assert_eq!(budget.held(), 320, "ada's charge released");

    let mut dave = budget.holding();

    dave.begin();

    assert!(dave.charge(134), "dave's head fits");
    assert!(!dave.charge(47), "dave, who would hold the most, cast off");
    assert!(dave.is_cast_off(), "dave cast off");
    assert_eq!(
        budget.held(),
        320,
        "dave's charge released, his last not taken"
    );
    assert!(!dave.charge(1), "nothing charged after");

    carol.end();
    assert_eq!(budget.held(), 146, "carol's whole: released");
}

#[tokio::test]
async fn casts_off_a_holder_past_its_grace_before_a_larger_one_within_it_the_earlier_among_equals()
{
    let clock = clock();
    let budget = budget_of(&clock, 300);
    let ada = holding_of(&budget, 100);

    clock.advance(Duration::from_millis(5_500)).await;

    let bob = holding_of(&budget, 150);
    let cid = holding_of(&budget, 50);
    let mut dee = budget.holding();

    dee.begin();

    assert!(dee.charge(10), "dee's charge taken");
    assert!(
        ada.is_cast_off(),
        "ada, past her grace, though she holds less than bob"
    );
    assert!(!bob.is_cast_off() && !cid.is_cast_off(), "bob and cid kept");

    // among equal sums, the one whose message began first
    let budget_equal = budget_of(&clock, 100);
    let first = holding_of(&budget_equal, 40);
    let second = holding_of(&budget_equal, 40);
    let mut third = budget_equal.holding();

    third.begin();

    assert!(third.charge(30), "the third's charge taken");
    assert!(first.is_cast_off(), "the first begun");
    assert!(!second.is_cast_off(), "the second kept");
}

#[tokio::test]
async fn counts_a_message_s_time_only_while_its_connection_is_not_paused() {
    let clock = clock();
    let budget = budget_of(&clock, 1_000);
    let holding = holding_of(&budget, 10);
    let partway = holding.partway();

    clock.advance(Duration::from_secs(1)).await;
    partway.pause();
    clock.advance(Duration::from_secs(9)).await;

    assert_eq!(partway.elapsed(), Some(Duration::from_secs(1)), "paused");

    partway.resume();
    clock.advance(Duration::from_secs(2)).await;

    assert_eq!(
        partway.elapsed(),
        Some(Duration::from_secs(3)),
        "counted again"
    );
}
