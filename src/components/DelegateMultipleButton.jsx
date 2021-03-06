import React, { Component } from 'react';
import Modal from 'react-modal';
import { utils } from 'web3';
import { Form, Input } from 'formsy-react-components';
import PropTypes from 'prop-types';
import { paramsForServer } from 'feathers-hooks-common';
import Slider from 'react-rangeslider';
import 'react-rangeslider/lib/index.css';
import BigNumber from 'bignumber.js';
import InputToken from 'react-input-token';

import { checkWalletBalance } from '../lib/middleware';
import { feathersClient } from '../lib/feathersClient';
import GivethWallet from '../lib/blockchain/GivethWallet';
import Loader from './Loader';

import Donation from '../models/Donation';
import Campaign from '../models/Campaign';
import User from '../models/User';

import DonationService from '../services/DonationService';

BigNumber.config({ DECIMAL_PLACES: 18 });
Modal.setAppElement('#root');

const modalStyles = {
  content: {
    top: '50%',
    left: '50%',
    right: 'auto',
    bottom: 'auto',
    marginRight: '-20%',
    transform: 'translate(-50%, -50%)',
    boxShadow: '0 0 40px #ccc',
    overflowY: 'scroll',
  },
};

/**
 * Retrieves the oldest 100 donations that can the user delegate
 *
 * @prop {GivethWallet} wallet      Wallet object
 * @prop {User}         currentUser Current user of the Dapp
 * @prop {Campaign}     campaign    If the delegation is towards campaign, this contains the campaign
 * @prop {Object}       milestone   It the delegation is towards campaign, this contains the milestone
 * @prop {Object}       style       Styles added to the button
 */
class DelegateMultipleButton extends Component {
  constructor(props) {
    super(props);

    this.state = {
      isSaving: false,
      isLoadingDonations: true,
      modalVisible: false,
      delegations: [],
      maxAmount: 0,
      delegationOptions: [],
      objectToDelegateFrom: [],
    };

    this.loadDonations = this.loadDonations.bind(this);
    this.selectedObject = this.selectedObject.bind(this);
    this.submit = this.submit.bind(this);
  }

  componentDidMount() {
    this.dacsObserver = feathersClient
      .service('dacs')
      .watch({ listStrategy: 'always' })
      .find({
        query: {
          delegateId: { $gt: '0' },
          ownerAddress: this.props.currentUser.address,
          $select: ['ownerAddress', 'title', '_id', 'delegateId', 'delegateEntity', 'delegate'],
        },
      })
      .subscribe(
        resp => {
          const dacs = resp.data.map(c => ({
            name: c.title,
            id: c._id,
            ownerAddress: c.ownerAddress,
            delegateId: c.delegateId,
            delegateEntity: c.delegateEntity,
            delegate: c.delegate,
            type: 'dac',
          }));

          const delegationOptions = this.props.milestone
            ? dacs.concat([
                {
                  id: this.props.milestone.campaign._id,
                  name: this.props.milestone.campaign.title,
                  projectId: this.props.milestone.campaign.projectId,
                  ownerEntity: this.props.milestone.ownerEntity,
                  type: 'campaign',
                },
              ])
            : dacs;

          this.setState({ delegationOptions }, () => {
            if (delegationOptions.length === 1) {
              this.selectedObject({ target: { value: [delegationOptions[0].id] } });
            }
          });
        },
        () => {},
      );
  }

  selectedObject({ target }) {
    this.setState({ objectToDelegateFrom: target.value, isLoadingDonations: true });
    this.loadDonations(target.value);
  }

  loadDonations(ids) {
    if (ids.length !== 1) return;

    const entity = this.state.delegationOptions.find(c => c.id === ids[0]);

    if (this.donationsObserver) this.donationsObserver.unsubscribe();

    const options = {};

    switch (entity.type) {
      case 'dac':
        options.delegateId = entity.delegateId;
        options.delegateTypeId = entity.id;
        options.status = Donation.WAITING;

        break;
      case 'campaign':
        options.ownerId = entity.projectId;
        options.ownerTypeId = entity.id;
        options.status = Donation.COMMITTED;
        break;
      default:
        break;
    }

    const query = paramsForServer({
      query: {
        amountRemaining: { $ne: 0 },
        ...options,
        $sort: { createdAt: 1 },
      },
      schema: 'includeTypeAndGiverDetails',
    });

    // start watching donations, this will re-run when donations change or are added
    this.donationsObserver = feathersClient
      .service('donations')
      .watch({ listStrategy: 'always' })
      .find(query)
      .subscribe(
        r => {
          const delegations = r.data.map(d => new Donation(d));
          let amount = utils.fromWei(
            delegations.reduce((sum, d) => sum.add(utils.toBN(d.amountRemaining)), utils.toBN('0')),
          );

          if (
            this.props.milestone &&
            new BigNumber(this.props.milestone.maxAmount).lt(new BigNumber(amount))
          )
            amount = this.props.milestone.maxAmount;

          this.setState({
            delegations,
            maxAmount: amount,
            amount,
            isLoadingDonations: false,
          });
        },
        () => this.setState({ isLoadingDonations: false }),
      );
  }

  openDialog() {
    checkWalletBalance(this.props.wallet).then(() => this.setState({ modalVisible: true }));
  }

  submit(model) {
    this.setState({ isSaving: true });

    const onCreated = txLink => {
      this.setState({ isSaving: false, modalVisible: false, objectToDelegateFrom: [] });
      React.swal({
        title: 'Delegated!',
        content: React.swal.msg(
          <span>
            The donations have been delegated,{' '}
            <a href={`${txLink}`} target="_blank" rel="noopener noreferrer">
              view the transaction here.
            </a>
            <p>
              The donations have been delegated. Please note the the Giver may have{' '}
              <strong>3 days</strong> to reject your delegation before the money gets committed.
            </p>
          </span>,
        ),
        icon: 'success',
      });
    };

    const onSuccess = txLink => {
      React.toast.success(
        <p>
          Your donation has been confirmed!
          <br />
          <a href={`${txLink}`} target="_blank" rel="noopener noreferrer">
            View transaction
          </a>
        </p>,
      );
    };

    DonationService.delegateMultiple(
      this.state.delegations,
      utils.toWei(model.amount),
      this.props.campaign || this.props.milestone,
      onCreated,
      onSuccess,
    );
  }

  render() {
    const style = { display: 'inline-block', ...this.props.style };
    const { isSaving, isLoading, delegationOptions, delegations, isLoadingDonations } = this.state;
    const { campaign, milestone } = this.props;

    return (
      <span style={style}>
        <button type="button" className="btn btn-info" onClick={() => this.openDialog()}>
          Delegate
        </button>

        <Modal
          isOpen={this.state.modalVisible}
          style={modalStyles}
          onRequestClose={() => {
            this.setState({ modalVisible: false });
          }}
        >
          <p>
            You are delegating donations to
            {campaign && <strong> {campaign.title}</strong>}
            {milestone && <strong> {milestone.campaign.title}</strong>}
          </p>
          {isLoading && <Loader className="small btn-loader" />}
          {!isLoading && (
            <Form onSubmit={this.submit} layout="vertical">
              <div className="form-group">
                <span className="label">Delegate from:</span>
                <InputToken
                  name="delegateFrom"
                  label="Delegate from:"
                  placeholder={this.props.campaign ? 'Select a DAC' : 'Select a DAC or Campaign'}
                  value={this.state.objectToDelegateFrom}
                  options={delegationOptions}
                  onSelect={this.selectedObject}
                  maxLength={1}
                />
              </div>

              {this.state.objectToDelegateFrom.length !== 1 && (
                <p>
                  Please select entity from which you want to delegate money to the{' '}
                  {campaign ? campaign.title : milestone.title}{' '}
                </p>
              )}
              {this.state.objectToDelegateFrom.length === 1 &&
                isLoadingDonations && <Loader className="small btn-loader" />}
              {this.state.objectToDelegateFrom.length === 1 &&
                !isLoadingDonations &&
                delegations.length === 0 && (
                  <p>
                    There are no delegations in the DAC or Campaign you have selected that can be
                    delegated.
                  </p>
                )}
              {this.state.objectToDelegateFrom.length === 1 &&
                !isLoadingDonations &&
                delegations.length > 0 && (
                  <div>
                    <span className="label">Amount to delegate:</span>

                    <div className="form-group">
                      <Slider
                        type="range"
                        name="amount2"
                        min={0}
                        max={Number(this.state.maxAmount)}
                        step={this.state.maxAmount / 10}
                        value={Number(this.state.amount)}
                        labels={{ 0: '0', [this.state.maxAmount]: this.state.maxAmount }}
                        format={val => `${val} ETH`}
                        onChange={amount =>
                          this.setState(prevState => ({
                            amount:
                              Number(amount).toFixed(2) > prevState.maxAmount
                                ? prevState.maxAmount
                                : Number(amount).toFixed(2),
                          }))
                        }
                      />
                    </div>

                    <div className="form-group">
                      <Input
                        type="text"
                        validations={`greaterThan:0,isNumeric,lessOrEqualTo:${
                          this.state.maxAmount
                        }`}
                        validationErrors={{
                          greaterThan: 'Enter value greater than 0',
                          lessOrEqualTo: `The donations you are delegating have combined value of ${
                            this.state.maxAmount
                          }. Do not input higher amount than that.`,
                          isNumeric: 'Provide correct number',
                        }}
                        name="amount"
                        value={this.state.amount}
                        onChange={(name, amount) => this.setState({ amount })}
                      />
                    </div>

                    <button
                      className="btn btn-success"
                      formNoValidate
                      type="submit"
                      disabled={isSaving}
                    >
                      {isSaving ? 'Delegating...' : 'Delegate here'}
                    </button>
                  </div>
                )}
            </Form>
          )}
        </Modal>
      </span>
    );
  }
}

DelegateMultipleButton.propTypes = {
  wallet: PropTypes.instanceOf(GivethWallet).isRequired,
  currentUser: PropTypes.instanceOf(User).isRequired,
  campaign: PropTypes.instanceOf(Campaign),
  milestone: PropTypes.shape(),
  style: PropTypes.shape(),
};

DelegateMultipleButton.defaultProps = {
  campaign: undefined,
  milestone: undefined,
  style: {},
};

export default DelegateMultipleButton;
