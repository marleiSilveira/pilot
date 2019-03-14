import React, { Component, Fragment } from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { withRouter } from 'react-router-dom'
import {
  allPass,
  always,
  applySpec,
  both,
  complement,
  anyPass,
  compose,
  cond,
  contains,
  curry,
  either,
  eqProps,
  equals,
  head,
  ifElse,
  isNil,
  map,
  partial,
  path,
  pathOr,
  pipe,
  prop,
  startsWith,
} from 'ramda'
import { translate } from 'react-i18next'
import moment from 'moment'
import { Alert } from 'former-kit'
import IconInfo from 'emblematic-icons/svg/Info32.svg'
import {
  destroyAnticipationAction as destroyAnticipation,
  requestLimits as requestAnticipationLimits,
} from '.'
import AnticipationContainer from '../../containers/Anticipation'
import env from '../../environment'
import partnersBankCodes from '../../models/partnersBanksCodes'

const mapStateToProps = ({
  account: {
    client,
    company: {
      pricing,
    } = {},
  },
  anticipation: {
    error,
    limits,
    loading,
  },
}) => ({
  client,
  error,
  limits,
  loading,
  pricing,
})

const mapDispatchToProps = {
  destroyAnticipationAction: destroyAnticipation,
  requestLimits: requestAnticipationLimits,
}

const enhanced = compose(
  translate(),
  connect(mapStateToProps, mapDispatchToProps),
  withRouter
)

const createBulk = (client, {
  automaticTransfer,
  paymentDate,
  recipientId,
  requestedAmount,
  timeframe,
}) => (
  client.bulkAnticipations.create({
    automatic_transfer: automaticTransfer,
    build: true,
    payment_date: paymentDate.valueOf(),
    recipientId,
    requested_amount: requestedAmount,
    timeframe,
  })
)

const updateBulk = (client, {
  automaticTransfer,
  bulkId,
  paymentDate,
  recipientId,
  requestedAmount,
  timeframe,
}) => client.bulkAnticipations.update({
  automatic_transfer: automaticTransfer,
  id: bulkId,
  payment_date: paymentDate.valueOf(),
  recipientId,
  requested_amount: requestedAmount,
  timeframe,
})

const confirmBulk = (client, {
  bulkId,
  recipientId,
}) => (
  client.bulkAnticipations.confirm({
    id: bulkId,
    recipientId,
  })
)

const destroyBulk = curry((client, {
  bulkId,
  recipientId,
}) => (
  client.bulkAnticipations.destroy({
    id: bulkId,
    recipientId,
  })
))

const getBuildingBulkAnticipations = (client, recipientId) =>
  client
    .bulkAnticipations
    .find({
      recipientId,
      status: 'building',
    })

const buildDeleteOption = applySpec({ bulkId: prop('id') })
const deleteBulkAnticipationPromises = client => map(destroyBulk(client))

const buildDeleteBuildingBulkAnticipation = client => pipe(
  map(buildDeleteOption),
  deleteBulkAnticipationPromises(client)
)

const getDefaultRecipient = client => client
  .company
  .current()
  .then(path(['default_recipient_id', env]))

const getRecipientById = (id, client) => (
  client.recipients.find({ id })
    .then(recipient => (
      Promise.all([
        Promise.resolve(recipient),
        client.recipient.balance(id),
      ])
        .then(([recipientData, balance]) => (
          { ...recipientData, balance }
        ))
    ))
)

const getErrorMessage = pipe(
  path(['response', 'errors']),
  head,
  prop('message')
)

const isInsuficientPayablesError = pipe(
  path(['response', 'status']),
  equals(409)
)

const getInsuficientPayablesError = t => ifElse(
  isInsuficientPayablesError,
  always(t('pages.anticipation.insuficient_payables')),
  getErrorMessage
)

const isPresent = date =>
  date.isSame(moment(), 'day')

const isFuture = date =>
  date.isAfter(moment())

const isBefore11AM = () =>
  moment().isBefore(moment().hours(11).minutes(0).seconds(0))

const isValidDay = (calendar, client) => allPass([
  either(
    both(
      isPresent,
      isBefore11AM
    ),
    isFuture
  ),
  partial(client.business.isBusinessDay, [calendar]),
])

const stepsId = {
  confirmation: 'confirmation',
  data: 'data',
  result: 'result',
}

const initialState = {
  approximateRequested: undefined,
  bulkAnticipationStatus: null,
  bulkId: null,
  calendar: {},
  currentStep: stepsId.data,
  error: null,
  feesValues: {
    anticipation: 0,
    fraud: 0,
    otherFee: 0,
  },
  invalidDays: [],
  isAutomaticTransfer: true,
  limits: {
    maxValue: 0,
    minValue: 0,
  },
  loading: false,
  paymentDate: moment(),
  requestedAmount: undefined,
  statusMessage: '',
  stepsStatus: {
    [stepsId.data]: 'current',
    [stepsId.confirmation]: 'pending',
    [stepsId.result]: 'pending',
  },
  timeframe: 'start',
}

const getStepsStatus = (nextStep, nextStepStatus) => {
  const buildStepsStatus = cond([
    [
      equals(stepsId.data),
      always({
        confirmation: 'pending',
        data: nextStepStatus,
        result: 'pending',
      }),
    ],
    [
      equals(stepsId.confirmation),
      always({
        confirmation: nextStepStatus,
        data: 'success',
        result: 'pending',
      }),
    ],
    [
      equals(stepsId.result),
      always({
        confirmation: 'success',
        data: 'success',
        result: nextStepStatus,
      }),
    ],
  ])

  return buildStepsStatus(nextStep)
}

const getRequestedAmount = (min, max, requested) => {
  if (requested <= min) {
    return min
  }

  if (requested >= max) {
    return max
  }

  return requested
}

const isInvalidRecipientId = anyPass([
  isNil,
  equals('undefined'),
  complement(startsWith('re_')),
])

const areEqualLimits = both(
  eqProps('max'),
  eqProps('min')
)

class Anticipation extends Component {
  constructor (props) {
    super(props)

    this.state = {
      ...initialState,
      bulkId: null,
    }

    this.calculateLimits = this.calculateLimits.bind(this)
    this.confirmAnticipation = this.confirmAnticipation.bind(this)
    this.createAnticipation = this.createAnticipation.bind(this)
    this.createOrUpdateAnticipation = this.createOrUpdateAnticipation.bind(this)
    this.getTransferCost = this.getTransferCost.bind(this)
    this.goTo = this.goTo.bind(this)
    this.goToBalance = this.goToBalance.bind(this)
    this.handleCalculateSubmit = this.handleCalculateSubmit.bind(this)
    this.handleConfirmationConfirm = this.handleConfirmationConfirm.bind(this)
    this.handleDateChange = this.handleDateChange.bind(this)
    this.handleFormChange = this.handleFormChange.bind(this)
    this.handleTimeframeChange = this.handleTimeframeChange.bind(this)
    this.resetAnticipation = this.resetAnticipation.bind(this)
    this.updateAnticipation = this.updateAnticipation.bind(this)
    this.updateRecipient = this.updateRecipient.bind(this)
  }

  componentDidMount () {
    const {
      client,
      history,
      match: {
        params: {
          id,
        },
      },
    } = this.props

    client
      .business
      .requestBusinessCalendar(moment().get('year'))
      .then((calendar) => {
        const nextAnticipableDay = client
          .business
          .nextAnticipableBusinessDay(
            calendar,
            { hour: 10, minute: 20 },
            moment()
          )

        this.setState({
          calendar,
          paymentDate: nextAnticipableDay,
        })
      })
      .catch(error => this.setState({ businessCalendarError: error }))

    if (isInvalidRecipientId(id)) {
      getDefaultRecipient(client)
        .then(recipientId => history.replace(`/anticipation/${recipientId}`))
    } else {
      this.updateRecipient(id)
    }
  }

  componentDidUpdate (prevProps) {
    const {
      history,
      limits,
      match: {
        params: {
          id,
        },
      },
    } = this.props

    const {
      limits: oldLimits,
      match: {
        params: {
          id: oldId,
        },
      },
    } = prevProps

    if (isInvalidRecipientId(id) && oldId) {
      history.replace(`/anticipation/${oldId}`)
    }

    if (id && id !== oldId) {
      this.updateRecipient(id)
    } else if (!areEqualLimits(oldLimits, limits)) {
      this.setState(// eslint-disable-line react/no-did-update-set-state
        {
          limits: {
            maxValue: limits.max,
            minValue: limits.min,
          },
          requestedAmount: limits.max,
        },
        this.createOrUpdateAnticipation.bind(this, limits.max)
      )
    }
  }

  componentWillUnmount () {
    const {
      bulkAnticipationStatus,
      bulkId,
    } = this.state

    const {
      destroyAnticipation,
      match: {
        params: {
          id: recipientId,
        },
      },
    } = this.props

    if (bulkAnticipationStatus && bulkAnticipationStatus !== 'pending') {
      destroyAnticipation({
        anticipationId: bulkId,
        recipientId,
      })
    }
  }

  getTransferCost () {
    const {
      recipient,
    } = this.state
    const bankCode = path(['bank_account', 'bank_code'], recipient)

    if (recipient && bankCode) {
      const {
        pricing: {
          transfers: {
            credito_em_conta: creditoEmConta,
            ted,
          },
        },
      } = this.props

      if (contains(partnersBankCodes, bankCode)) {
        return creditoEmConta
      }

      return -ted
    }

    return 0
  }

  updateRecipient (id) {
    const { client } = this.props

    getRecipientById(id, client)
      .then((recipient) => {
        this.setState({
          loading: true,
          recipient,
        }, () => {
          this.setState({
            loading: false,
            transferCost: this.getTransferCost(),
          })

          getBuildingBulkAnticipations(client, recipient.id)
            .then(buildDeleteBuildingBulkAnticipation(client))
            .then(deletePromises => Promise.all(deletePromises)
              .then(this.calculateLimits))
        })
      })
  }

  calculateLimits () {
    const { requestAnticipationLimits } = this.props

    return requestAnticipationLimits
  }

  resetAnticipation () {
    const { limits: { minValue } } = this.state
    return this.createOrUpdateAnticipation(minValue)
      .then(this.calculateLimits)
  }

  handleTimeframeChange (timeframe) {
    this.setState(
      { timeframe },
      this.resetAnticipation.bind(this)
    )
  }

  handleDateChange ({ start }) {
    this.setState(
      { paymentDate: start },
      this.resetAnticipation.bind(this)
    )
  }

  handleCalculateSubmit ({
    date,
    isAutomaticTransfer,
    requested,
    timeframe,
  }) {
    this.setState({
      loading: true,
    })

    const { t } = this.props

    this.resetAnticipation()
      .then(() => {
        const {
          limits: {
            maxValue,
            minValue,
          },
        } = this.state

        const requestedAmount = getRequestedAmount(
          minValue,
          maxValue,
          requested
        )

        this.setState({
          error: null,
          isAutomaticTransfer,
          paymentDate: date,
          requestedAmount,
          timeframe,
          transferCost: isAutomaticTransfer
            ? this.getTransferCost()
            : 0,
        })

        this.updateAnticipation(requestedAmount)
      })
      .catch(pipe(
        getInsuficientPayablesError(t),
        message => this.setState({
          error: message,
          loading: false,
        })
      ))
  }

  createOrUpdateAnticipation (minValue) {
    const {
      bulkId,
      requestedAmount,
    } = this.state

    if (!bulkId) {
      return this.createAnticipation(minValue)
    }

    this.setState({ loading: true })

    return this.updateAnticipation(minValue || requestedAmount)
  }

  handleConfirmationConfirm (password) {
    const {
      client,
      t,
    } = this.props

    const { session_id: sessionId } = client.authentication

    this.setState({
      loading: true,
    })

    client.session.verify({
      id: sessionId,
      password,
    })
      .then(({ valid }) => {
        if (valid) {
          this.setState({
            error: '',
          })

          this.confirmAnticipation()
        } else {
          this.setState({
            error: t('pages.anticipation.wrong_pass'),
            loading: false,
          })
        }
      })
  }

  handleFormChange (data, { requested }) {
    this.setState({
      error: requested !== this.state.error
        ? requested
        : null,
    })
  }

  goTo (nextStep, nextStepStatus) {
    this.setState({
      currentStep: nextStep,
      stepsStatus: getStepsStatus(nextStep, nextStepStatus),
    })
  }

  goToBalance () {
    const {
      recipient: {
        id,
      },
    } = this.state

    const {
      history,
    } = this.props
    history.push(`/balance/${id}`)
  }

  updateAnticipation (value) {
    const {
      bulkId,
      isAutomaticTransfer,
      paymentDate,
      recipient: {
        id: recipientId,
      },
      requestedAmount,
      timeframe,
    } = this.state

    const {
      client,
    } = this.props

    return updateBulk(client, {
      automaticTransfer: isAutomaticTransfer,
      bulkId,
      paymentDate,
      recipientId,
      requestedAmount: value || requestedAmount,
      timeframe,
    })
      .then(({
        amount,
        anticipation_fee: anticipationFee,
        fee,
        fraud_coverage_fee: fraudCoverageFee,
        status,
      }) => {
        const {
          limits: {
            maxValue,
            minValue,
          },
        } = this.state

        this.setState({
          approximateRequested: amount,
          bulkAnticipationStatus: status,
          feesValues: {
            anticipation: anticipationFee,
            fraud: fraudCoverageFee,
            otherFee: fee,
          },
          loading: false,
          requestedAmount: getRequestedAmount(
            minValue,
            maxValue,
            requestedAmount
          ),
        })
      })
      .catch(pipe(getErrorMessage, error => this.setState({
        error,
        loading: false,
      })))
  }

  confirmAnticipation () {
    const {
      bulkId,
      recipient: {
        id: recipientId,
      },
    } = this.state

    const {
      client,
      t,
    } = this.props

    confirmBulk(client, {
      bulkId,
      recipientId,
    })
      .then(({ status }) => {
        this.setState({
          bulkAnticipationStatus: status,
          currentStep: 'result',
          loading: false,
          statusMessage: t('pages.anticipation.anticipation_success'),
          stepsStatus: getStepsStatus('result', 'success'),
        })
      })
      .catch(pipe(getErrorMessage, error => this.setState({
        currentStep: 'result',
        loading: false,
        statusMessage: error,
        stepsStatus: getStepsStatus('result', 'error'),
      })))
  }

  createAnticipation (value) {
    const {
      isAutomaticTransfer,
      limits: {
        maxValue,
        minValue,
      },
      paymentDate,
      recipient: {
        id: recipientId,
      },
      requestedAmount,
      timeframe,
    } = this.state

    const {
      client,
    } = this.props

    return createBulk(client, {
      automaticTransfer: isAutomaticTransfer,
      paymentDate,
      recipientId,
      requestedAmount: value || requestedAmount,
      timeframe,
    })
      .then(({
        amount,
        anticipation_fee: anticipationFee,
        fee,
        fraud_coverage_fee: fraudCovarageFee,
        id,
        status,
      }) => {
        this.setState({
          approximateRequested: amount,
          bulkAnticipationStatus: status,
          bulkId: id,
          error: null,
          feesValues: {
            anticipation: anticipationFee,
            fraud: fraudCovarageFee,
            otherFee: fee,
          },
          loading: false,
          requestedAmount: getRequestedAmount(
            minValue,
            maxValue,
            requestedAmount
          ),
        })
      })
      .catch(pipe(getErrorMessage, error => this.setState({
        error,
      })))
  }

  render () {
    const {
      approximateRequested,
      businessCalendarError,
      calendar,
      currentStep,
      error,
      feesValues: {
        anticipation,
        fraud,
        otherFee,
      },
      isAutomaticTransfer,
      limits: {
        maxValue,
        minValue,
      },
      loading,
      paymentDate,
      recipient,
      requestedAmount,
      statusMessage,
      stepsStatus,
      timeframe,
      transferCost,
    } = this.state

    const {
      client,
      error: limitsError,
      loading: limitsLoading,
      t,
    } = this.props

    const totalCost = -(anticipation + fraud + otherFee)
    const amount = approximateRequested + totalCost + transferCost

    if (businessCalendarError) {
      return (
        <Alert
          icon={<IconInfo height={16} width={16} />}
          type="info"
        >
          <span>
            {limitsError && limitsError}
            {pathOr(
                t('pages.balance.unknown_error'),
                ['errors', 0, 'message'],
                error
            )}
          </span>
        </Alert>
      )
    }

    return (
      <Fragment>
        {!isNil(recipient) &&
          <AnticipationContainer
            amount={amount}
            approximateRequested={approximateRequested}
            automaticTransfer={isAutomaticTransfer}
            currentStep={currentStep}
            date={paymentDate}
            error={error}
            loading={loading || limitsLoading}
            maximum={maxValue}
            minimum={minValue}
            onAnticipationDateConfirm={this.handleDateConfirm}
            onCalculateSubmit={this.handleCalculateSubmit}
            onCancel={this.goToBalance}
            onConfirmationConfirm={this.handleConfirmationConfirm}
            onConfirmationReturn={() => this.goTo('data', 'current')}
            onDataConfirm={() => this.goTo('confirmation', 'current')}
            onFormChange={this.handleFormChange}
            onTimeframeChange={this.handleTimeframeChange}
            onTryAgain={() => this.goTo('data', 'current')}
            onViewStatement={this.goToBalance}
            recipient={recipient}
            requested={requestedAmount}
            statusMessage={statusMessage}
            stepsStatus={stepsStatus}
            t={t}
            timeframe={timeframe}
            totalCost={totalCost}
            transferCost={isAutomaticTransfer && transferCost
              ? transferCost
              : 0
            }
            validateDay={isValidDay(calendar, client)}
          />
        }
      </Fragment>
    )
  }
}

Anticipation.propTypes = {
  client: PropTypes.shape({
    bulkAnticipations: PropTypes.shape({
      limits: PropTypes.func,
    }).isRequired,
  }).isRequired,
  destroyAnticipation: PropTypes.func.isRequired,
  error: PropTypes.string,
  history: PropTypes.shape({
    goBack: PropTypes.func,
    push: PropTypes.func,
    replace: PropTypes.func,
  }).isRequired,
  limits: PropTypes.shape({
    max: PropTypes.number.isRequired,
    min: PropTypes.number.isRequired,
  }).isRequired,
  loading: PropTypes.bool,
  match: PropTypes.shape({
    params: PropTypes.shape({
      id: PropTypes.string,
    }).isRequired,
  }).isRequired,
  pricing: PropTypes.shape({
    transfers: PropTypes.shape({
      credito_em_conta: PropTypes.number,
      ted: PropTypes.number,
    }),
  }).isRequired,
  requestAnticipationLimits: PropTypes.func.isRequired,
  t: PropTypes.func.isRequired,
}

Anticipation.defaultProps = {
  error: '',
  loading: false,
}

export default enhanced(Anticipation)